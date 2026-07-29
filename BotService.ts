import type TokenRingApp from "@tokenring-ai/app";
import { type ConfigLayer, ConfigurationService } from "@tokenring-ai/app";
import type { ConfigApplyResult } from "@tokenring-ai/app/config/ConfigurationService";
import { ConfigurationError, type TokenRingService } from "@tokenring-ai/app/types";
import EnhancedMap from "@tokenring-ai/utility/map/enhancedMap";
import KeyedRegistry from "@tokenring-ai/utility/registry/KeyedRegistry";
import Bot from "./Bot.ts";
import type { CommunicationChannel } from "./CommunicationChannel.ts";
import { createGroupChannel } from "./groupChannel.ts";
import type { ChannelMembership, IncomingMessage, MessagingProvider } from "./MessagingProvider.ts";
import type { BotUserRole, ParsedBotServiceConfig } from "./schema.ts";
import { splitIntoChunks } from "./splitIntoChunks.ts";

/** A user, channel, or group address in `service:id` form. */
export type BotTarget = { service: string; id: string };

/** A room the bot is in that no bot has been configured into yet. */
export type DiscoveredChannel = {
  /** `service:channelId` */
  target: string;
  title?: string | undefined;
  discoveredAt: number;
  /** `service:userId` of whoever added the bot, when the platform said. */
  invitedBy?: string | undefined;
};

/**
 * Somebody waiting on an answer in a conversation. `accepts` decides whether a
 * given message is that answer — in a group it must be a reply to something the
 * channel itself posted, so an outreach cannot swallow the room's other traffic.
 */
type OutreachListener = {
  accepts: (message: IncomingMessage) => boolean;
  deliver: (message: IncomingMessage) => void;
};

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
  private discovered = new EnhancedMap<string, DiscoveredChannel>();

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
    channelWriteScope: "user",
  };

  constructor(private readonly app: TokenRingApp) {}

  async reconfigure(newConfig: ParsedBotServiceConfig) {
    this.config = newConfig;

    await this.bots.reconcileAgainstAsync(newConfig.bots, {
      creating: (name, config) => {
        const bot = new Bot(this.app, this, name, config);
        // A bot built from config must be told about the providers that are
        // already connected, or it never announces itself anywhere.
        this.announceProvidersTo(bot);
        return bot;
      },
      deleting: async (_name, bot) => await bot.stop(),
      updating: (_name, bot, updatedConfig) => {
        bot.reconfigure(updatedConfig);
        // Channels added by this config change need announcing too.
        this.announceProvidersTo(bot);
        return bot;
      },
    });

    // A channel a bot has since been configured into is no longer "discovered".
    for (const target of this.discovered.keysArray()) {
      if (this.botHoldingChannel(target)) this.discovered.delete(target);
    }
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
    provider.onMembershipChange?.(event => this.handleMembershipChange(service, event));

    for (const bot of this.bots.values()) {
      bot.onProviderAvailable(service, provider);
    }
  }

  unregisterProvider(service: string): void {
    this.providers.unregister(service);
  }

  registerBot(name: string, bot: Bot): void {
    this.bots.set(name, bot);
    this.announceProvidersTo(bot);
  }

  parseTarget(target: string): BotTarget {
    const [, service, id] = target.match(/^(.*?):(.*)$/) ?? [];
    if (!service || !id) {
      throw new ConfigurationError(this.name, `Invalid target "${target}", expected service:userId`);
    }

    return { service, id };
  }

  /** Rooms the bot is in that no bot has been configured into, newest first. */
  listDiscoveredChannels(): DiscoveredChannel[] {
    return this.discovered
      .valuesArray()
      .filter(channel => !this.botHoldingChannel(channel.target))
      .sort((a, b) => b.discoveredAt - a.discoveredAt);
  }

  /**
   * Writes a new bot into the configuration and applies it, which starts the bot
   * without a restart. The fields are handed to `BotConfigSchema` by `apply`
   * rather than checked here, so the schema stays the single definition of what
   * a bot may be.
   */
  async createBot(name: string, config: Record<string, unknown>): Promise<ConfigApplyResult> {
    if (this.bots.get(name)) {
      throw new ConfigurationError(this.name, `A bot named "${name}" already exists`);
    }

    return this.updateBots(bots => ({ ...bots, [name]: config }));
  }

  /**
   * Removes a bot from the override layer. A bot defined in a layer below it
   * survives — configuration merges layers, so there is nothing to write here
   * that would unsay it. Callers check `getBot` afterwards to find out.
   */
  async deleteBot(name: string): Promise<ConfigApplyResult> {
    if (!this.bots.get(name)) {
      throw new ConfigurationError(this.name, `Unknown bot: ${name}`);
    }

    return this.updateBots(bots => Object.fromEntries(Object.entries(bots).filter(([botName]) => botName !== name)));
  }

  /** Adds a person to a bot, or changes the role they already have. */
  async setUserRole(botName: string, userTarget: string, role: BotUserRole): Promise<ConfigApplyResult> {
    if (!this.bots.get(botName)) {
      throw new ConfigurationError(this.name, `Unknown bot: ${botName}`);
    }
    // Validated here rather than at apply, where a bad target would be reported
    // against the record key and read as a schema error about `users`.
    this.parseTarget(userTarget);

    return this.updateBotUsers(botName, users => ({ ...users, [userTarget]: role }));
  }

  /** Removes a person from a bot. Subject to the same layering caveat as `deleteBot`. */
  async removeUser(botName: string, userTarget: string): Promise<ConfigApplyResult> {
    if (!this.bots.get(botName)) {
      throw new ConfigurationError(this.name, `Unknown bot: ${botName}`);
    }

    return this.updateBotUsers(botName, users => Object.fromEntries(Object.entries(users).filter(([target]) => target !== userTarget)));
  }

  /**
   * Adds a channel to a bot's configuration and applies it, so the bot starts
   * answering there — and, because applying re-runs `reconfigure`, announces
   * itself there too.
   */
  async joinChannel(botName: string, target: string, channelName?: string): Promise<ConfigApplyResult> {
    if (!this.bots.get(botName)) {
      throw new ConfigurationError(this.name, `Unknown bot: ${botName}`);
    }
    const { service } = this.parseTarget(target);
    if (service !== GROUP_SERVICE && !this.providers.get(service)) {
      throw new ConfigurationError(this.name, `No messaging service named "${service}" is connected`);
    }

    const existing = this.bots.get(botName)?.channelConfigForTarget(target);
    if (existing) return { ok: true };

    const name = channelName ?? this.channelNameFor(botName, target);

    return this.updateBotChannels(botName, channels => ({ ...channels, [name]: { target } }));
  }

  /** Removes a channel from a bot's configuration and applies it. */
  async leaveChannel(botName: string, target: string): Promise<ConfigApplyResult> {
    const bot = this.bots.get(botName);
    if (!bot) {
      throw new ConfigurationError(this.name, `Unknown bot: ${botName}`);
    }

    return this.updateBotChannels(botName, channels =>
      Object.fromEntries(Object.entries(channels).filter(([, channel]) => (channel as { target?: string }).target !== target)),
    );
  }

  /**
   * Opens a conversation with a user, channel, or broadcast group, for a bot
   * that needs an answer rather than just somewhere to write.
   *
   * In a 1:1 chat every reply is the answer. In a group only replies to the
   * channel's own messages are, so the bot watching the room keeps hearing
   * everything else.
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

    /** Message ids this channel has posted, and the replies it has taken. */
    const ownMessageIds = new Set<string>();
    /** The channel's first message, so its follow-ups stay in one thread. */
    let threadAnchor: string | undefined;

    const listener: OutreachListener = {
      accepts: message => message.direct || (message.replyToMessageId !== undefined && ownMessageIds.has(message.replyToMessageId)),
      deliver: message => {
        // Remember the reply too, so replying to one's own message keeps the
        // thread with this channel rather than handing it back to the agent.
        if (message.messageId) ownMessageIds.add(message.messageId);

        if (pending) {
          pending({ value: message.text, done: false });
          pending = undefined;
        } else {
          queue.push(message.text);
        }
      },
    };
    this.addOutreachListener(key, listener);

    return {
      send: async (message: string) => {
        for (const chunk of splitIntoChunks(message, provider.maxMessageLength)) {
          const messageId = await provider.sendMessage(conversationId, chunk, threadAnchor ? { replyToMessageId: threadAnchor } : undefined);
          ownMessageIds.add(messageId);
          threadAnchor ??= messageId;
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
        ownMessageIds.clear();
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

  private announceProvidersTo(bot: Bot): void {
    for (const [service, provider] of this.providers.entriesArray()) {
      bot.onProviderAvailable(service, provider);
    }
  }

  private async routeIncomingMessage(service: string, provider: MessagingProvider, message: IncomingMessage): Promise<void> {
    try {
      const conversationKey = `${service}:${message.conversationId}`;

      // A bot waiting on an answer in this conversation gets the reply, rather
      // than the agent that otherwise watches it. In a group that only applies
      // to replies addressed at the outreach itself.
      for (const listener of this.outreachListeners.get(conversationKey) ?? []) {
        if (!listener.accepts(message)) continue;
        listener.deliver(message);
        return;
      }

      const bot = this.findBotFor(service, message);
      if (!bot) return;

      await bot.handleMessage(service, provider, message);
    } catch (error: unknown) {
      this.app.serviceError(this, `Error handling ${service} message from ${message.userId}:`, error);
    }
  }

  private async handleMembershipChange(service: string, event: ChannelMembership): Promise<void> {
    const target = `${service}:${event.conversationId}`;

    if (!event.joined) {
      this.discovered.delete(target);
      return;
    }

    // Already somebody's channel — nothing to discover, nothing to join.
    if (this.botHoldingChannel(target)) return;

    const invitedBy = event.byUserId ? `${service}:${event.byUserId}` : undefined;
    this.discovered.set(target, {
      target,
      title: event.title,
      discoveredAt: Date.now(),
      invitedBy,
    });

    // `observed` means we merely noticed traffic from a room we were already
    // in. Nobody invited us just now, so nothing may join on the strength of it.
    if (event.via !== "invite") return;

    const candidates = this.bots.valuesArray().filter(bot => this.wouldAutoJoin(bot, invitedBy));
    if (candidates.length === 0) return;
    if (candidates.length > 1) {
      this.app.serviceError(this, `${candidates.length} bots would auto-join ${target}; leaving it for "/bots join" to settle`);
      return;
    }

    const bot = candidates[0]!;
    try {
      const result = await this.joinChannel(bot.name, target, this.channelNameFor(bot.name, target, event.title));
      if (result.ok) {
        this.app.serviceOutput(this, `Bot ${bot.name} joined ${event.title ?? target}`);
      } else {
        this.app.serviceError(
          this,
          `Bot ${bot.name} could not join ${target}:`,
          result.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        );
      }
    } catch (error: unknown) {
      this.app.serviceError(this, `Bot ${bot.name} could not join ${target}:`, error);
    }
  }

  private wouldAutoJoin(bot: Bot, invitedBy: string | undefined): boolean {
    switch (bot.config.joinPolicy) {
      case "whenInvited":
        return true;
      case "whenInvitedByAdmin":
        return invitedBy !== undefined && bot.roleOf(invitedBy) === "admin";
      default:
        return false;
    }
  }

  private botHoldingChannel(target: string): Bot | undefined {
    return this.bots.valuesArray().find(bot => bot.channelConfigForTarget(target) !== undefined);
  }

  /** A readable, unique key for the channel in the bot's `channels` map. */
  private channelNameFor(botName: string, target: string, title?: string): string {
    const { id } = this.parseTarget(target);
    const base =
      title
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `channel${id.replace(/[^a-z0-9]/gi, "")}`;

    const taken = new Set(Object.keys(this.bots.get(botName)?.config.channels ?? {}));
    if (!taken.has(base)) return base;

    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix++;
    return `${base}-${suffix}`;
  }

  /**
   * Rewrites one bot's `channels` in the configured override layer and applies
   * it, which live-reconfigures every plugin and persists the layer to disk.
   */
  private async updateBotChannels(botName: string, update: (channels: Record<string, unknown>) => Record<string, unknown>): Promise<ConfigApplyResult> {
    return this.updateBots(bots => {
      const botOverrides = bots[botName] ?? {};
      // The override layer holds only what this scope overrides, so a bot defined
      // in a lower layer may have no `channels` here at all. Merge onto whatever
      // the bot is actually running with, so an edit never drops its siblings.
      const channels = { ...this.bots.get(botName)?.config.channels, ...((botOverrides.channels ?? {}) as Record<string, unknown>) };

      return { ...bots, [botName]: { ...botOverrides, channels: update(channels) } };
    });
  }

  /** The same, for the `users` map. */
  private async updateBotUsers(botName: string, update: (users: Record<string, unknown>) => Record<string, unknown>): Promise<ConfigApplyResult> {
    return this.updateBots(bots => {
      const botOverrides = bots[botName] ?? {};
      const users = { ...this.bots.get(botName)?.config.users, ...((botOverrides.users ?? {}) as Record<string, unknown>) };

      return { ...bots, [botName]: { ...botOverrides, users: update(users) } };
    });
  }

  /**
   * Rewrites the whole `bot.bots` map in the configured override layer and
   * applies it, which live-reconfigures every plugin and persists the layer.
   */
  private async updateBots(update: (bots: Record<string, Record<string, unknown>>) => Record<string, Record<string, unknown>>): Promise<ConfigApplyResult> {
    const configService = this.app.getService(ConfigurationService);
    if (!configService) {
      throw new ConfigurationError(this.name, "Bots cannot be changed at runtime because no ConfigurationService is installed");
    }

    const scope = this.config.channelWriteScope;
    const overrides = configService.getOverrides(scope);
    const bot = (overrides.bot ?? {}) as { bots?: Record<string, Record<string, unknown>> };

    const next = {
      ...overrides,
      bot: { ...bot, bots: update(bot.bots ?? {}) },
    } satisfies ConfigLayer;

    return configService.apply(scope, next);
  }

  /**
   * Finds the bot a message belongs to: for a channel, the bot that joined it;
   * for a DM, the bot that lists the sender.
   */
  private findBotFor(service: string, message: IncomingMessage): Bot | undefined {
    // A message from a thread inside a room — a forum topic — is claimed by
    // whoever joined the room, or by a bot configured into that thread alone.
    const conversationTarget = `${service}:${message.conversationId}`;
    const roomTarget = `${service}:${message.roomId ?? message.conversationId}`;
    const userTarget = `${service}:${message.userId}`;

    const matches = this.bots
      .valuesArray()
      .filter(bot =>
        message.direct
          ? bot.acceptsDirectMessagesFrom(userTarget)
          : bot.channelConfigForTarget(conversationTarget) !== undefined || bot.channelConfigForTarget(roomTarget) !== undefined,
      );

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
