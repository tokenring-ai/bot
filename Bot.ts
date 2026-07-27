import { type Agent, AgentManager } from "@tokenring-ai/agent";
import { AgentEventState } from "@tokenring-ai/agent/state/agentEventState";
import type TokenRingApp from "@tokenring-ai/app";
import EnhancedMap from "@tokenring-ai/utility/map/enhancedMap";
import type BotService from "./BotService.ts";
import type { CommunicationChannel } from "./CommunicationChannel.ts";
import ConversationStream from "./ConversationStream.ts";
import type { IncomingMessage, MessagingProvider } from "./MessagingProvider.ts";
import { parseCommand } from "./parseCommand.ts";
import type { BotUserRole, ParsedBotChannelConfig, ParsedBotConfig } from "./schema.ts";
import { ThrottledBatchProcessor } from "./ThrottledBatchProcessor.ts";

/** One place the bot is talking, and the agent that is doing the talking. */
type Conversation = {
  service: string;
  provider: MessagingProvider;
  conversationId: string;
  agentType: string;
  agent: Agent;
  /** The response currently being streamed back, if any. */
  stream?: ConversationStream | undefined;
  activeRequests: Set<string>;
  listening: boolean;
  startedAt: number;
  lastActivityAt: number;
};

/** A live conversation, as reported to callers outside the bot. */
export type BotConversationInfo = {
  key: string;
  service: string;
  conversationId: string;
  agentId: string;
  agentType: string;
  /** The configured channel this conversation belongs to, if it is one. */
  channelName?: string | undefined;
  startedAt: number;
  lastActivityAt: number;
  /** True while the agent is working on a message. */
  busy: boolean;
};

/**
 * A bot: one personality, expressed by its agent type, reachable in any number
 * of channels across any number of platforms.
 *
 * Every channel it sits in and every user who DMs it gets an agent of its own,
 * so conversations do not bleed into each other, and all of them are spawned
 * from the agent type configured on the bot.
 */
export default class Bot {
  private conversations = new EnhancedMap<string, Conversation>();
  private announcedServices = new Set<string>();
  private batchProcessor = new ThrottledBatchProcessor<string>(keys => this.flushConversations(keys), 250);

  constructor(
    private readonly app: TokenRingApp,
    private readonly botService: BotService,
    readonly name: string,
    public config: ParsedBotConfig,
  ) {}

  reconfigure(newConfig: ParsedBotConfig): void {
    this.config = newConfig;
  }

  get displayName(): string {
    return this.config.displayName ?? this.name;
  }

  /** Every `service:channelId` this bot sits in. */
  channelTargets(): string[] {
    return Object.values(this.config.channels).map(channel => channel.target);
  }

  channelConfigForTarget(target: string): ParsedBotChannelConfig | undefined {
    return Object.values(this.config.channels).find(channel => channel.target === target);
  }

  roleOf(userTarget: string): BotUserRole | undefined {
    return this.config.users[userTarget];
  }

  acceptsDirectMessagesFrom(userTarget: string): boolean {
    switch (this.config.directMessages) {
      case "none":
        return false;
      case "anyone":
        return true;
      default:
        return this.roleOf(userTarget) !== undefined;
    }
  }

  /**
   * Announces the bot in the channels it holds on a service, once that
   * service's provider has connected.
   */
  onProviderAvailable(service: string, provider: MessagingProvider): void {
    if (!this.config.joinMessage || this.announcedServices.has(service)) return;
    this.announcedServices.add(service);

    const joinMessage = this.config.joinMessage;
    for (const target of this.channelTargets()) {
      const parsed = this.botService.parseTarget(target);
      if (parsed.service !== service) continue;

      this.app.runBackgroundTask(this.botService, async () => {
        try {
          const conversationId = await provider.resolveConversation(parsed.id);
          await provider.sendMessage(conversationId, joinMessage);
        } catch (error: unknown) {
          this.error(`Bot ${this.name} failed to announce itself in ${target}:`, error);
        }
      });
    }
  }

  /** Handles a message the service has already decided belongs to this bot. */
  async handleMessage(service: string, provider: MessagingProvider, msg: IncomingMessage): Promise<void> {
    const userTarget = `${service}:${msg.userId}`;
    const conversationKey = `${service}:${msg.conversationId}`;
    const text = msg.text.trim();
    const attachments = msg.attachments ?? [];

    let agentType: string;
    if (msg.direct) {
      if (!this.acceptsDirectMessagesFrom(userTarget)) {
        await provider.sendMessage(
          msg.conversationId,
          this.config.directMessages === "none" ? "DMs are not enabled for this bot." : "Sorry, you are not authorized to DM this bot.",
        );
        return;
      }
      agentType = this.config.agentType;
    } else {
      const channelConfig = this.channelConfigForTarget(conversationKey);
      if (!channelConfig) return;
      if (this.config.requireMention && !msg.addressed) return;

      if (channelConfig.allowedUsers.length > 0 && !channelConfig.allowedUsers.includes(userTarget)) {
        await provider.sendMessage(msg.conversationId, "Sorry, you are not authorized.");
        return;
      }
      agentType = channelConfig.agentType ?? this.config.agentType;
    }

    if (!text && attachments.length === 0) return;

    const conversation = this.ensureConversation(conversationKey, service, provider, msg.conversationId, agentType);
    conversation.lastActivityAt = Date.now();
    const parsed = parseCommand(text, this.config.commandMapping, msg.userName ?? msg.userId);

    if (parsed.type !== "chat" && this.roleOf(userTarget) !== "admin") {
      await provider.sendMessage(msg.conversationId, "Sorry, only administrators of this bot can run commands.");
      return;
    }

    switch (parsed.type) {
      case "stop":
        conversation.agent.abortCurrentOperation(`Abort requested by ${userTarget}`);
        return;
      case "unknown":
        await provider.sendMessage(msg.conversationId, `Unknown command: ${parsed.command}`);
        return;
    }

    await conversation.agent.waitForState(AgentEventState, state => state.idle);

    // Finish writing the previous response before the next one starts sharing
    // the conversation.
    await this.batchProcessor.flush();
    conversation.stream ??= new ConversationStream(provider, msg.conversationId, error => this.error("Error writing to conversation:", error));

    const requestId = conversation.agent.handleInput({
      from: `${service} message from ${msg.userName ?? msg.userId}`,
      message: parsed.message,
      attachments,
    });
    conversation.activeRequests.add(requestId);
  }

  /** Opens a channel to a user or group so the bot can start a conversation. */
  contact(target: string): Promise<CommunicationChannel> {
    return this.botService.openChannel(target);
  }

  /** Sends a one-off message to a user or group, without waiting for a reply. */
  async sendMessage(target: string, message: string): Promise<void> {
    await this.botService.sendMessage(target, message);
  }

  /** The conversations the bot is currently holding, newest activity first. */
  listConversations(): BotConversationInfo[] {
    const channelNames = new Map(Object.entries(this.config.channels).map(([name, channel]) => [channel.target, name]));

    return this.conversations
      .entriesArray()
      .map(([key, conversation]) => ({
        key,
        service: conversation.service,
        conversationId: conversation.conversationId,
        agentId: conversation.agent.id,
        agentType: conversation.agentType,
        channelName: channelNames.get(key),
        startedAt: conversation.startedAt,
        lastActivityAt: conversation.lastActivityAt,
        busy: conversation.activeRequests.size > 0,
      }))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /**
   * Ends a conversation and deletes its agent. The next message in it starts
   * over with a fresh agent and no history.
   */
  resetConversation(key: string): boolean {
    const conversation = this.conversations.get(key);
    if (!conversation) return false;

    this.conversations.delete(key);
    this.app.requireService(AgentManager).deleteAgent(conversation.agent.id, `Conversation ${key} was reset.`);
    return true;
  }

  async stop(): Promise<void> {
    await this.batchProcessor.flush();
    this.batchProcessor.dispose();

    const agentManager = this.app.requireService(AgentManager);
    for (const conversation of this.conversations.values()) {
      agentManager.deleteAgent(conversation.agent.id, `Bot ${this.name} was shut down.`);
    }
    this.conversations.clear();
    this.announcedServices.clear();
  }

  private ensureConversation(key: string, service: string, provider: MessagingProvider, conversationId: string, agentType: string): Conversation {
    const existing = this.conversations.get(key);
    if (existing) return existing;

    const agentManager = this.app.requireService(AgentManager);
    const now = Date.now();
    const conversation: Conversation = {
      service,
      provider,
      conversationId,
      agentType,
      agent: agentManager.spawnAgent({ agentType, headless: true }),
      activeRequests: new Set(),
      listening: true,
      startedAt: now,
      lastActivityAt: now,
    };
    this.conversations.set(key, conversation);

    conversation.agent.runBackgroundTask(signal => this.agentEventLoop(key, conversation, signal));

    return conversation;
  }

  private async agentEventLoop(key: string, conversation: Conversation, signal: AbortSignal): Promise<void> {
    const { agent } = conversation;
    const eventCursor = agent.getState(AgentEventState).getEventCursorFromCurrentPosition();
    try {
      for await (const state of agent.subscribeStateAsync(AgentEventState, signal)) {
        for (const event of state.yieldEventsByCursor(eventCursor)) {
          switch (event.type) {
            case "output.chat":
              this.appendToStream(key, conversation, event.message);
              break;
            case "output.info":
            case "output.warning":
            case "output.error":
              this.appendToStream(key, conversation, `\n[${event.type.split(".")[1]!.toUpperCase()}]: ${event.message}\n`);
              break;
            case "agent.response": {
              if (!conversation.activeRequests.delete(event.requestId)) break;
              this.appendToStream(key, conversation, `\n\n${event.message}`);
              conversation.stream?.markComplete();
              await this.batchProcessor.flush();
              break;
            }
          }
        }
      }
    } catch (error: unknown) {
      if (Error.isError(error) && error.name !== "AbortError") {
        this.error(`Error listening to conversation ${key}:`, error);
      }
    } finally {
      conversation.listening = false;
    }
  }

  private appendToStream(key: string, conversation: Conversation, content: string): void {
    conversation.stream ??= new ConversationStream(conversation.provider, conversation.conversationId, error =>
      this.error("Error writing to conversation:", error),
    );
    conversation.stream.append(content);
    conversation.lastActivityAt = Date.now();
    this.batchProcessor.add(key);
  }

  private async flushConversations(keys: string[]): Promise<void> {
    for (const key of keys) {
      const conversation = this.conversations.get(key);
      const stream = conversation?.stream;
      if (!conversation || !stream) continue;

      await stream.flush();
      if (stream.isComplete) {
        conversation.stream = undefined;
      }
    }
  }

  private error(...messages: unknown[]): void {
    this.app.serviceError(this.botService, ...messages);
  }
}
