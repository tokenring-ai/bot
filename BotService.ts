import type TokenRingApp from "@tokenring-ai/app";
import { ConfigurationError, type TokenRingService } from "@tokenring-ai/app/types";
import EnhancedMap from "@tokenring-ai/utility/map/enhancedMap";
import KeyedRegistry from "@tokenring-ai/utility/registry/KeyedRegistry";
import Bot from "./Bot.ts";
import type { CommunicationChannel } from "./CommunicationChannel.ts";
import { createGroupChannel } from "./groupChannel.ts";
import type { IncomingMessage, MessagingProvider } from "./MessagingProvider.ts";
import type { ParsedBotServiceConfig } from "./schema.ts";
import { splitIntoChunks } from "./splitIntoChunks.ts";

/** A user, channel, or group address in `service:id` form. */
export type BotTarget = { service: string; id: string };

type OutreachListener = (message: string) => void;

/** Service name reserved for broadcast groups defined in this plugin's config. */
export const GROUP_SERVICE = "group";

/**
 * Holds the bots and the messaging providers they speak through, and routes
 * every inbound message to whichever bot owns the conversation it arrived in.
 *
 * Bots know nothing about platforms and providers know nothing about agents —
 * this is the only place the two meet.
 */
export default class BotService implements TokenRingService {
  readonly name = "BotService";
  description = "Runs channel-agnostic bots across messaging platforms";

  private providers = new KeyedRegistry<MessagingProvider>();
  private bots = new KeyedRegistry<Bot>();
  private outreachListeners = new EnhancedMap<string, Set<OutreachListener>>();

  getProvider = this.providers.get;
  requireProvider = this.providers.require;
  getProviderNames = this.providers.keysArray;
  getBot = this.bots.get;
  requireBot = this.bots.require;
  getBotNames = this.bots.keysArray;
  getBots = this.bots.valuesArray;

  config: ParsedBotServiceConfig = {
    bots: {},
    groups: {},
  };

  constructor(private readonly app: TokenRingApp) {}

  async reconfigure(newConfig: ParsedBotServiceConfig) {
    await this.bots.reconcileAgainstAsync(newConfig.bots, {
      creating: (name, config) => new Bot(this.app, this, name, config),
      deleting: async (_name, bot) => await bot.stop(),
      updating: (_name, bot, newConfig) => {
        bot.reconfigure(newConfig);
        return bot;
      },
    });

    this.config = newConfig;
  }

  /**
   * Registers a platform account under the name that addresses it — the
   * `service` half of `service:userId`.
   */
  registerProvider(service: string, provider: MessagingProvider): void {
    if (service === GROUP_SERVICE) {
      throw new ConfigurationError(this.name, `"${GROUP_SERVICE}" is reserved for broadcast groups and cannot name a messaging provider`);
    }
    this.providers.set(service, provider);
    provider.onMessage(message => this.routeIncomingMessage(service, provider, message));

    for (const bot of this.bots.values()) {
      bot.onProviderAvailable(service, provider);
    }
  }

  unregisterProvider(service: string): void {
    this.providers.unregister(service);
  }

  registerBot(name: string, bot: Bot): void {
    this.bots.set(name, bot);
    for (const [service, provider] of this.providers.entriesArray()) {
      bot.onProviderAvailable(service, provider);
    }
  }

  parseTarget(target: string): BotTarget {
    const [, service, id] = target.match(/^(.*?):(.*)$/) ?? [];
    if (!service || !id) {
      throw new ConfigurationError(this.name, `Invalid target "${target}", expected service:userId`);
    }

    return { service, id };
  }

  /**
   * Opens a conversation with a user, channel, or broadcast group, for a bot
   * that needs an answer rather than just somewhere to write.
   *
   * While the channel is open it takes every reply in that conversation, so
   * the bot's own agent does not also try to answer them.
   */
  async openChannel(target: string, visitedGroups: ReadonlySet<string> = new Set()): Promise<CommunicationChannel> {
    const { service, id } = this.parseTarget(target);

    if (service === GROUP_SERVICE) {
      const members = this.config.groups[id];
      if (!members) throw new ConfigurationError(this.name, `Unknown group: ${id}`);
      if (visitedGroups.has(id)) throw new ConfigurationError(this.name, `Group ${id} contains itself`);
      return createGroupChannel(this, id, members, visitedGroups);
    }

    const provider = this.requireProvider(service);
    const conversationId = await provider.resolveConversation(id);
    const key = `${service}:${conversationId}`;

    const queue: string[] = [];
    let pending: ((result: IteratorResult<string>) => void) | undefined;
    let closed = false;

    const listener: OutreachListener = message => {
      if (pending) {
        pending({ value: message, done: false });
        pending = undefined;
      } else {
        queue.push(message);
      }
    };
    this.addOutreachListener(key, listener);

    return {
      send: async (message: string) => {
        for (const chunk of splitIntoChunks(message, provider.maxMessageLength)) {
          await provider.sendMessage(conversationId, chunk);
        }
      },
      receive: async function* (): AsyncGenerator<string> {
        while (!closed) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          const result = await new Promise<IteratorResult<string>>(resolve => {
            pending = resolve;
          });
          if (result.done) return;
          yield result.value;
        }
      },
      [Symbol.dispose]: () => {
        closed = true;
        pending?.({ value: undefined, done: true });
        pending = undefined;
        this.removeOutreachListener(key, listener);
      },
    };
  }

  /** Sends a message to a user, channel, or group without waiting for a reply. */
  async sendMessage(target: string, message: string, visitedGroups: ReadonlySet<string> = new Set()): Promise<void> {
    const { service, id } = this.parseTarget(target);

    if (service === GROUP_SERVICE) {
      const members = this.config.groups[id];
      if (!members) throw new ConfigurationError(this.name, `Unknown group: ${id}`);
      if (visitedGroups.has(id)) throw new ConfigurationError(this.name, `Group ${id} contains itself`);
      const seen = new Set(visitedGroups).add(id);
      await Promise.all(members.map(member => this.sendMessage(member, message, seen)));
      return;
    }

    const provider = this.requireProvider(service);
    const conversationId = await provider.resolveConversation(id);
    for (const chunk of splitIntoChunks(message, provider.maxMessageLength)) {
      await provider.sendMessage(conversationId, chunk);
    }
  }

  async stop(): Promise<void> {
    for (const bot of this.bots.values()) {
      await bot.stop();
    }
  }

  private async routeIncomingMessage(service: string, provider: MessagingProvider, message: IncomingMessage): Promise<void> {
    try {
      const conversationKey = `${service}:${message.conversationId}`;

      // A bot waiting on an answer in this conversation gets the reply, rather
      // than the agent that otherwise watches it.
      const listeners = this.outreachListeners.get(conversationKey);
      if (listeners?.size) {
        for (const listener of listeners) listener(message.text);
        return;
      }

      const bot = this.findBotFor(service, message);
      if (!bot) return;

      await bot.handleMessage(service, provider, message);
    } catch (error: unknown) {
      this.app.serviceError(this, `Error handling ${service} message from ${message.userId}:`, error);
    }
  }

  /**
   * Finds the bot a message belongs to: for a channel, the bot that joined it;
   * for a DM, the bot that lists the sender.
   */
  private findBotFor(service: string, message: IncomingMessage): Bot | undefined {
    const conversationTarget = `${service}:${message.conversationId}`;
    const userTarget = `${service}:${message.userId}`;

    const matches = this.bots
      .valuesArray()
      .filter(bot => (message.direct ? bot.acceptsDirectMessagesFrom(userTarget) : bot.channelConfigForTarget(conversationTarget) !== undefined));

    if (matches.length > 1) {
      this.app.serviceError(this, `${matches.length} bots claim ${message.direct ? `DMs from ${userTarget}` : conversationTarget}; using ${matches[0]!.name}`);
    }
    return matches[0];
  }

  private addOutreachListener(conversationKey: string, listener: OutreachListener): void {
    const listeners = this.outreachListeners.get(conversationKey) ?? new Set<OutreachListener>();
    listeners.add(listener);
    this.outreachListeners.set(conversationKey, listeners);
  }

  private removeOutreachListener(conversationKey: string, listener: OutreachListener): void {
    const listeners = this.outreachListeners.get(conversationKey);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.outreachListeners.delete(conversationKey);
  }
}
