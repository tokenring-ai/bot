import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import AgentManager from "@tokenring-ai/agent/services/AgentManager";
import createTestingAgent from "@tokenring-ai/agent/test/createTestingAgent.test";
import type TokenRingApp from "@tokenring-ai/app";
import type { ConfigScope } from "@tokenring-ai/app";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import deepClone from "@tokenring-ai/utility/object/deepClone";
import BotService from "./BotService.ts";
import ConversationStream from "./ConversationStream.ts";
import type { ChannelMembership, IncomingMessage, IncomingMessageHandler, MembershipHandler, MessagingProvider, SendOptions } from "./MessagingProvider.ts";
import botRPC from "./rpc/bot.ts";
import { BotServiceConfigSchema } from "./schema.ts";

class FakeMessagingProvider implements MessagingProvider {
  readonly maxMessageLength = 20;
  sent: { conversationId: string; text: string; replyTo?: string | undefined }[] = [];
  private handlers: IncomingMessageHandler[] = [];
  private membershipHandlers: MembershipHandler[] = [];

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  onMembershipChange(handler: MembershipHandler): void {
    this.membershipHandlers.push(handler);
  }

  async sendMessage(conversationId: string, text: string, options?: SendOptions): Promise<string> {
    this.sent.push({ conversationId, text, replyTo: options?.replyToMessageId });
    return `m${this.sent.length}`;
  }

  async updateMessage(_conversationId: string, messageId: string, _text: string): Promise<string> {
    return messageId;
  }

  /** Users get a `D-` prefixed conversation, channels address themselves. */
  resolveConversation(targetId: string): string {
    return targetId.startsWith("U") ? `D-${targetId}` : targetId;
  }

  deliver(message: Partial<IncomingMessage> & Pick<IncomingMessage, "conversationId" | "userId">): Promise<void[]> {
    const full: IncomingMessage = {
      text: "hello",
      direct: false,
      addressed: true,
      hasAttachments: false,
      ...message,
    };
    return Promise.all(this.handlers.map(async handler => handler(full)));
  }

  announceMembership(event: ChannelMembership): Promise<void[]> {
    return Promise.all(this.membershipHandlers.map(async handler => handler(event)));
  }
}

/**
 * Stands in for the real configuration service. Named for the class it replaces
 * because the service registry keys on `constructor.name`.
 *
 * It does what the real one does in the way that matters here: validate the
 * candidate layer against the schema, keep it, and live-reconfigure the bot
 * service — so a test can watch a bot created over RPC actually start.
 */
class ConfigurationService {
  readonly name = "ConfigurationService";
  readonly description = "Test double for the configuration service";
  /** Layers below the one bots write to, e.g. a checked-in project config. */
  base: Record<string, unknown> = {};
  private layers: Record<ConfigScope, Record<string, unknown>> = { global: {}, workspace: {} };

  constructor(private readonly reconfigure: (config: unknown) => Promise<void>) {}

  getOverrides(scope: ConfigScope): Record<string, unknown> {
    return structuredClone(this.layers[scope] ?? {});
  }

  async apply(scope: ConfigScope, next: Record<string, unknown>) {
    // The real merge, so the test double layers exactly the way the app does —
    // including the part that matters here: removing a key from the upper layer
    // cannot unsay the lower one.
    const merged = deepClone(this.base, (next.bot ?? {}) as Record<string, unknown>);

    const parsed = BotServiceConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return { ok: false as const, issues: parsed.error.issues.map(issue => ({ path: issue.path as (string | number)[], message: issue.message })) };
    }

    this.layers[scope] = next;
    await this.reconfigure(parsed.data);
    return { ok: true as const };
  }
}

const botConfig = {
  agentType: "helper",
  users: { "chat:U-admin": "admin", "chat:U-member": "user" },
  channels: {
    engineering: { target: "chat:C-eng" },
    ops: { target: "chat:C-ops", agentType: "ops-helper", allowedUsers: ["chat:U-admin"] },
  },
};

describe("BotService", () => {
  let app: TokenRingApp;
  let botService: BotService;
  let provider: FakeMessagingProvider;
  let spawnAgent: ReturnType<typeof spyOn>;
  let handleInput: ReturnType<typeof mock>;

  /** Builds the service the way the plugin does: config only, no manual registerBot. */
  async function buildService(overrides: Record<string, unknown> = {}) {
    const config = BotServiceConfigSchema.parse({
      bots: { helper: { ...botConfig, ...overrides } },
      groups: { "dev-team": ["chat:U-admin", "chat:U-member"] },
    });

    provider = new FakeMessagingProvider();
    botService = new BotService(app);
    await botService.reconfigure(config);
    botService.registerProvider("chat", provider);
  }

  beforeEach(async () => {
    mock.clearAllMocks();

    app = createTestingApp();
    const agentManager = new AgentManager(app);
    app.addService(agentManager);

    handleInput = mock().mockReturnValue("request-1");
    spawnAgent = spyOn(agentManager, "spawnAgent").mockImplementation(() => {
      const agent = createTestingAgent(app);
      spyOn(agent, "handleInput").mockImplementation(handleInput);
      spyOn(agent, "waitForState").mockResolvedValue(undefined as never);
      spyOn(agent, "runBackgroundTask").mockReturnValue(undefined);
      return agent;
    });

    await buildService();
  });

  it("routes a channel message to the bot that joined the channel", async () => {
    await provider.deliver({ conversationId: "C-eng", userId: "U-member", text: "ship it" });

    expect(spawnAgent).toHaveBeenCalledWith({ agentType: "helper", headless: true });
    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleInput.mock.calls[0]![0].message).toContain("ship it");
  });

  it("gives each channel its own agent, of the type configured for it", async () => {
    await provider.deliver({ conversationId: "C-eng", userId: "U-admin" });
    await provider.deliver({ conversationId: "C-ops", userId: "U-admin" });

    expect(spawnAgent.mock.calls.map((call: [{ agentType: string }]) => call[0].agentType)).toEqual(["helper", "ops-helper"]);
  });

  it("reuses the same agent for repeated messages in a conversation", async () => {
    await provider.deliver({ conversationId: "C-eng", userId: "U-member" });
    await provider.deliver({ conversationId: "C-eng", userId: "U-admin" });

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(handleInput).toHaveBeenCalledTimes(2);
  });

  it("ignores channels the bot has not joined", async () => {
    await provider.deliver({ conversationId: "C-other", userId: "U-admin" });

    expect(handleInput).not.toHaveBeenCalled();
  });

  it("ignores channel messages that do not address the bot", async () => {
    await provider.deliver({ conversationId: "C-eng", userId: "U-admin", addressed: false });

    expect(handleInput).not.toHaveBeenCalled();
  });

  it("turns away users a channel does not allow", async () => {
    await provider.deliver({ conversationId: "C-ops", userId: "U-member" });

    expect(handleInput).not.toHaveBeenCalled();
    expect(provider.sent.at(-1)?.text).toContain("not authorized");
  });

  it("accepts DMs from listed users", async () => {
    await provider.deliver({ conversationId: "D-U-member", userId: "U-member", direct: true });

    expect(handleInput).toHaveBeenCalledTimes(1);
  });

  it("stays silent when an unlisted user DMs it", async () => {
    await provider.deliver({ conversationId: "D-U-stranger", userId: "U-stranger", direct: true });

    expect(handleInput).not.toHaveBeenCalled();
    expect(provider.sent).toEqual([]);
  });

  it("answers anyone when DMs are open", async () => {
    await buildService({ directMessages: "anyone" });

    await provider.deliver({ conversationId: "D-U-stranger", userId: "U-stranger", direct: true });

    expect(handleInput).toHaveBeenCalledTimes(1);
  });

  it("lets admins run commands, but not ordinary users", async () => {
    await provider.deliver({ conversationId: "C-eng", userId: "U-admin", text: "/reset" });
    expect(handleInput.mock.calls[0]![0].message).toBe("/chat reset");

    await provider.deliver({ conversationId: "C-eng", userId: "U-member", text: "/reset" });
    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(provider.sent.at(-1)?.text).toContain("only administrators");
  });

  /** What the plugin actually does: the transport connects, then config arrives. */
  async function configureBot(overrides: Record<string, unknown> = {}) {
    await botService.reconfigure(
      BotServiceConfigSchema.parse({
        bots: { helper: { ...botConfig, ...overrides } },
        groups: { "dev-team": ["chat:U-admin", "chat:U-member"] },
      }),
    );
    // Announcements are dispatched as background tasks.
    await Promise.resolve();
  }

  it("announces a bot configured after the platform connected", async () => {
    provider = new FakeMessagingProvider();
    botService = new BotService(app);
    botService.registerProvider("chat", provider);

    await configureBot({ joinMessage: "Helper reporting for duty." });

    expect(
      provider.sent
        .filter(message => message.text === "Helper reporting for duty.")
        .map(message => message.conversationId)
        .sort(),
    ).toEqual(["C-eng", "C-ops"]);
  });

  it("announces only the channel a config change added, not the ones it already greeted", async () => {
    provider = new FakeMessagingProvider();
    botService = new BotService(app);
    botService.registerProvider("chat", provider);

    await configureBot({ joinMessage: "Hello." });
    await configureBot({
      joinMessage: "Hello.",
      channels: { ...botConfig.channels, support: { target: "chat:C-support" } },
    });

    expect(
      provider.sent
        .filter(message => message.text === "Hello.")
        .map(message => message.conversationId)
        .sort(),
    ).toEqual(["C-eng", "C-ops", "C-support"]);
  });

  it("does not fetch a message's files unless it handles the message", async () => {
    const fetchAttachments = mock().mockResolvedValue([]);
    const withFiles = { hasAttachments: true, attachments: fetchAttachments };

    // A channel no bot joined never reaches a bot at all.
    await provider.deliver({ conversationId: "C-other", userId: "U-admin", ...withFiles });
    // A user the channel does not allow is turned away by the bot.
    await provider.deliver({ conversationId: "C-ops", userId: "U-member", ...withFiles });
    // A message that does not address the bot is ignored by it.
    await provider.deliver({ conversationId: "C-eng", userId: "U-admin", addressed: false, ...withFiles });

    expect(fetchAttachments).not.toHaveBeenCalled();

    await provider.deliver({ conversationId: "C-eng", userId: "U-admin", ...withFiles });
    expect(fetchAttachments).toHaveBeenCalledTimes(1);
  });

  it("hands one message at a time to a conversation's agent", async () => {
    const trace: string[] = [];
    /** Stands in for anything slow inside the critical section — a file fetch. */
    const slow = (label: string) => async () => {
      trace.push(`start:${label}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      trace.push(`end:${label}`);
      return [];
    };

    // Two messages arriving together, as two independent platform callbacks.
    const first = provider.deliver({ conversationId: "C-eng", userId: "U-admin", hasAttachments: true, attachments: slow("first") });
    const second = provider.deliver({ conversationId: "C-eng", userId: "U-admin", hasAttachments: true, attachments: slow("second") });
    await Promise.all([first, second]);

    // Unqueued, both would be in flight at once and the trace would interleave.
    expect(trace).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    expect(handleInput).toHaveBeenCalledTimes(2);
  });

  it("answers in the thread the question was asked in, and in the room otherwise", async () => {
    // The agent's own reply, streamed back, is what has to land in the thread.
    // Its event loop is mocked out here, so the stream is flushed by hand.
    const answer = async (msg: Partial<IncomingMessage>) => {
      await provider.deliver({ conversationId: "C-eng", userId: "U-admin", ...msg });
      const bot = botService.requireBot("helper") as unknown as {
        listConversations(): { key: string }[];
        flushConversations(keys: string[]): Promise<void>;
      };
      await bot.flushConversations([bot.listConversations()[0]!.key]);
    };

    await answer({ text: "asked in the room" });
    expect(provider.sent.at(-1)).toMatchObject({ conversationId: "C-eng", replyTo: undefined });

    botService.requireBot("helper").resetConversation("chat:C-eng");
    await answer({ text: "asked in a thread", replyToMessageId: "t1" });
    expect(provider.sent.at(-1)).toMatchObject({ conversationId: "C-eng", replyTo: "t1" });
  });

  it("keeps a conversation working after one of its messages fails", async () => {
    const failing = mock().mockRejectedValue(new Error("download failed"));

    await provider.deliver({ conversationId: "C-eng", userId: "U-admin", hasAttachments: true, attachments: failing });
    await provider.deliver({ conversationId: "C-eng", userId: "U-admin", text: "still listening" });

    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(handleInput.mock.calls[0]![0].message).toContain("still listening");
  });

  describe("forum topics", () => {
    it("governs a topic by its room's config, but gives it an agent of its own", async () => {
      await provider.deliver({ conversationId: "C-eng:42", roomId: "C-eng", userId: "U-member", text: "in a topic" });
      await provider.deliver({ conversationId: "C-eng:43", roomId: "C-eng", userId: "U-member", text: "another topic" });
      await provider.deliver({ conversationId: "C-eng:42", roomId: "C-eng", userId: "U-admin", text: "same topic" });

      // The bot was configured into `chat:C-eng`, not into each of its topics.
      expect(handleInput).toHaveBeenCalledTimes(3);
      // One agent per topic, so two topics never share history.
      expect(spawnAgent).toHaveBeenCalledTimes(2);
    });

    it("answers inside the topic, while taking permission from the room", async () => {
      await provider.deliver({ conversationId: "C-ops:7", roomId: "C-ops", userId: "U-member" });

      expect(handleInput).not.toHaveBeenCalled();
      expect(provider.sent).toMatchObject([{ conversationId: "C-ops:7", text: "Sorry, you are not authorized." }]);
    });

    it("lets a channel configured for one topic win over the room's", async () => {
      await buildService({
        channels: {
          engineering: { target: "chat:C-eng" },
          releases: { target: "chat:C-eng:42", agentType: "release-helper", allowedUsers: ["chat:U-admin"] },
        },
      });

      await provider.deliver({ conversationId: "C-eng:42", roomId: "C-eng", userId: "U-admin" });
      // The room would have let this one through; the topic's config does not.
      await provider.deliver({ conversationId: "C-eng:42", roomId: "C-eng", userId: "U-member" });
      // Another topic of the same forum still falls back to the room.
      await provider.deliver({ conversationId: "C-eng:43", roomId: "C-eng", userId: "U-member" });

      expect(spawnAgent.mock.calls.map((call: [{ agentType: string }]) => call[0].agentType)).toEqual(["release-helper", "helper"]);
      expect(provider.sent).toMatchObject([{ conversationId: "C-eng:42", text: "Sorry, you are not authorized." }]);
    });

    it("reports a topic's conversation under the room's channel name", async () => {
      await provider.deliver({ conversationId: "C-eng:42", roomId: "C-eng", userId: "U-member" });

      expect(botService.requireBot("helper").listConversations()).toMatchObject([{ channelName: "engineering", conversationId: "C-eng:42" }]);
    });
  });

  describe("joining groups", () => {
    it("reports a room nobody has joined, and stops once a bot has", async () => {
      await provider.announceMembership({ conversationId: "C-new", title: "New Room", joined: true, byUserId: "U-admin", via: "invite" });

      expect(botService.listDiscoveredChannels()).toMatchObject([{ target: "chat:C-new", title: "New Room", invitedBy: "chat:U-admin" }]);

      // A room a bot already sits in is not a discovery.
      await provider.announceMembership({ conversationId: "C-eng", title: "Engineering", joined: true, via: "observed" });
      expect(botService.listDiscoveredChannels().map(channel => channel.target)).toEqual(["chat:C-new"]);
    });

    it("forgets a room the bot was removed from", async () => {
      await provider.announceMembership({ conversationId: "C-new", joined: true, via: "invite" });
      await provider.announceMembership({ conversationId: "C-new", joined: false, via: "invite" });

      expect(botService.listDiscoveredChannels()).toEqual([]);
    });

    it("never auto-joins on a room it merely noticed traffic from", async () => {
      await buildService({ joinPolicy: "whenInvited" });
      const joinChannel = spyOn(botService, "joinChannel");

      await provider.announceMembership({ conversationId: "C-new", joined: true, byUserId: "U-admin", via: "observed" });

      expect(joinChannel).not.toHaveBeenCalled();
      expect(botService.listDiscoveredChannels().map(channel => channel.target)).toEqual(["chat:C-new"]);
    });

    it("auto-joins when an admin invites it, and not when anyone else does", async () => {
      await buildService({ joinPolicy: "whenInvitedByAdmin" });
      const joinChannel = spyOn(botService, "joinChannel").mockResolvedValue({ ok: true });

      await provider.announceMembership({ conversationId: "C-new", joined: true, byUserId: "U-member", via: "invite" });
      expect(joinChannel).not.toHaveBeenCalled();

      await provider.announceMembership({ conversationId: "C-new2", joined: true, byUserId: "U-admin", via: "invite" });
      expect(joinChannel).toHaveBeenCalledTimes(1);
      expect(joinChannel.mock.calls[0]![1]).toBe("chat:C-new2");
    });
  });

  describe("reaching out", () => {
    it("opens a channel to a user, chunked to the platform limit", async () => {
      await using channel = await botService.openChannel("chat:U-admin");
      await channel.send("a message that is definitely longer than twenty characters");

      expect(provider.sent.length).toBeGreaterThan(1);
      expect(provider.sent.every(message => message.conversationId === "D-U-admin")).toBe(true);
    });

    it("delivers replies to the waiting channel instead of the bot", async () => {
      await using channel = await botService.openChannel("chat:U-admin");
      const replies = channel.receive();

      const received = replies.next();
      await provider.deliver({ conversationId: "D-U-admin", userId: "U-admin", text: "approve", direct: true });

      expect((await received).value).toBe("approve");
      expect(handleInput).not.toHaveBeenCalled();
    });

    it("leaves a channel's other traffic to the agent, taking only replies to itself", async () => {
      await using channel = await botService.openChannel("chat:C-eng");
      await channel.send("Ship it?");
      const ownMessageId = provider.sent.at(-1)!.conversationId === "C-eng" ? "m1" : undefined;
      expect(ownMessageId).toBe("m1");

      const replies = channel.receive();
      const received = replies.next();

      // Somebody else talking in the room is still the agent's to answer.
      await provider.deliver({ conversationId: "C-eng", userId: "U-member", text: "unrelated chatter" });
      expect(handleInput).toHaveBeenCalledTimes(1);

      // A reply to the outreach is the answer it was waiting for.
      await provider.deliver({ conversationId: "C-eng", userId: "U-admin", text: "approve", replyToMessageId: "m1" });

      expect((await received).value).toBe("approve");
      expect(handleInput).toHaveBeenCalledTimes(1);
    });

    it("broadcasts to every member of a group", async () => {
      await botService.sendMessage("group:dev-team", "standup");

      expect(provider.sent.map(message => message.conversationId).sort()).toEqual(["D-U-admin", "D-U-member"]);
    });

    it("rejects targets that are not service:id", () => {
      expect(botService.sendMessage("nonsense", "hi")).rejects.toThrow("Invalid target");
    });
  });

  describe("RPC", () => {
    let configService: ConfigurationService;

    beforeEach(() => {
      app.addService(botService);
      configService = new ConfigurationService(config => botService.reconfigure(config as never));
      // The bot the suite starts with comes from a layer below the one bots
      // write to, exactly like a bot defined in a checked-in project config.
      configService.base = { bots: { helper: botConfig }, groups: { "dev-team": ["chat:U-admin", "chat:U-member"] } };
      app.addService(configService as never);
    });

    it("reports bots, their channels, people, and connected services", async () => {
      const result = await botRPC.methods.listBots.execute({}, app);

      expect(result.services).toEqual([{ name: "chat", maxMessageLength: 20 }]);
      expect(result.groups).toEqual([{ name: "dev-team", members: ["chat:U-admin", "chat:U-member"] }]);
      expect(result.bots).toHaveLength(1);

      const bot = result.bots[0]!;
      expect(bot).toMatchObject({ name: "helper", displayName: "helper", agentType: "helper", directMessages: "listed" });
      expect(bot.channels).toEqual([
        { name: "engineering", target: "chat:C-eng", service: "chat", channelId: "C-eng", agentType: "helper", allowedUsers: [], connected: true },
        { name: "ops", target: "chat:C-ops", service: "chat", channelId: "C-ops", agentType: "ops-helper", allowedUsers: ["chat:U-admin"], connected: true },
      ]);
      expect(bot.users).toEqual([
        { target: "chat:U-admin", service: "chat", userId: "U-admin", role: "admin" },
        { target: "chat:U-member", service: "chat", userId: "U-member", role: "user" },
      ]);
      expect(bot.conversations).toEqual([]);
    });

    it("reports a live conversation once someone has messaged the bot", async () => {
      await provider.deliver({ conversationId: "C-eng", userId: "U-member" });

      const result = await botRPC.methods.listBots.execute({}, app);

      expect(result.bots[0]!.conversations).toMatchObject([
        { key: "chat:C-eng", service: "chat", conversationId: "C-eng", agentType: "helper", channelName: "engineering", busy: true },
      ]);
    });

    it("resets a conversation, and reports when there is nothing to reset", async () => {
      await provider.deliver({ conversationId: "C-eng", userId: "U-member" });

      expect(botRPC.methods.resetConversation.execute({ bot: "helper", conversationKey: "chat:C-eng" }, app)).toEqual({ status: "success" });
      expect(botRPC.methods.resetConversation.execute({ bot: "helper", conversationKey: "chat:C-eng" }, app)).toEqual({ status: "conversationNotFound" });
      expect(botRPC.methods.resetConversation.execute({ bot: "nobody", conversationKey: "chat:C-eng" }, app)).toEqual({ status: "botNotFound" });
    });

    it("sends a message, and refuses targets whose service is not connected", async () => {
      await expect(botRPC.methods.sendMessage.execute({ target: "chat:U-admin", message: "hello" }, app)).resolves.toEqual({ status: "success" });
      expect(provider.sent).toEqual([{ conversationId: "D-U-admin", text: "hello" }]);

      await expect(botRPC.methods.sendMessage.execute({ target: "carrier-pigeon:U-admin", message: "hello" }, app)).resolves.toEqual({
        status: "providerNotFound",
      });
    });

    it("creates a bot that is running by the time the call returns", async () => {
      await expect(
        botRPC.methods.createBot.execute({ name: "triage", agentType: "assistant", displayName: "Triage", users: { "chat:U-admin": "admin" } }, app),
      ).resolves.toEqual({ status: "success" });

      const created = botService.requireBot("triage");
      expect(created.displayName).toBe("Triage");
      expect(created.roleOf("chat:U-admin")).toBe("admin");

      // A second one under the same name would silently replace it.
      await expect(botRPC.methods.createBot.execute({ name: "triage", agentType: "assistant" }, app)).resolves.toEqual({ status: "botExists" });
    });

    it("hands back the schema's own complaint about a bot it will not accept", async () => {
      const result = await botRPC.methods.createBot.execute({ name: "broken", agentType: "assistant", users: { "chat:U-admin": "wizard" as never } }, app);

      expect(result.status).toBe("configRejected");
      expect(botService.getBot("broken")).toBeUndefined();
    });

    it("adds and removes the people who may talk to a bot", async () => {
      await expect(botRPC.methods.createBot.execute({ name: "triage", agentType: "assistant" }, app)).resolves.toEqual({ status: "success" });

      await expect(botRPC.methods.setUserRole.execute({ bot: "triage", target: "chat:U-member", role: "user" }, app)).resolves.toEqual({ status: "success" });
      expect(botService.requireBot("triage").roleOf("chat:U-member")).toBe("user");

      await expect(botRPC.methods.setUserRole.execute({ bot: "triage", target: "chat:U-member", role: "admin" }, app)).resolves.toEqual({ status: "success" });
      expect(botService.requireBot("triage").roleOf("chat:U-member")).toBe("admin");

      await expect(botRPC.methods.removeUser.execute({ bot: "triage", target: "chat:U-member" }, app)).resolves.toEqual({ status: "success" });
      expect(botService.requireBot("triage").roleOf("chat:U-member")).toBeUndefined();

      await expect(botRPC.methods.setUserRole.execute({ bot: "nobody", target: "chat:U-member", role: "user" }, app)).resolves.toEqual({
        status: "botNotFound",
      });
    });

    it("deletes a bot it wrote, and says so when one is defined in a layer below", async () => {
      await expect(botRPC.methods.createBot.execute({ name: "triage", agentType: "assistant" }, app)).resolves.toEqual({ status: "success" });
      await expect(botRPC.methods.deleteBot.execute({ name: "triage" }, app)).resolves.toEqual({ status: "success" });
      expect(botService.getBot("triage")).toBeUndefined();

      // `helper` lives in the base layer, which nothing written here can unsay.
      await expect(botRPC.methods.deleteBot.execute({ name: "helper" }, app)).resolves.toEqual({ status: "definedElsewhere" });
      expect(botService.getBot("helper")).toBeDefined();

      await expect(botRPC.methods.deleteBot.execute({ name: "triage" }, app)).resolves.toEqual({ status: "botNotFound" });
    });

    it("reports a channel it could not leave because a lower layer configures it", async () => {
      await expect(botRPC.methods.leaveChannel.execute({ bot: "helper", target: "chat:C-eng" }, app)).resolves.toEqual({ status: "definedElsewhere" });
      expect(botService.requireBot("helper").channelConfigForTarget("chat:C-eng")).toBeDefined();
    });

    it("joins a discovered channel and leaves one it wrote itself", async () => {
      await expect(botRPC.methods.joinChannel.execute({ bot: "helper", target: "chat:C-new", name: "new-room" }, app)).resolves.toEqual({
        status: "success",
      });
      expect(botService.requireBot("helper").channelConfigForTarget("chat:C-new")).toBeDefined();

      await expect(botRPC.methods.leaveChannel.execute({ bot: "helper", target: "chat:C-new" }, app)).resolves.toEqual({ status: "success" });
      expect(botService.requireBot("helper").channelConfigForTarget("chat:C-new")).toBeUndefined();
    });
  });
});

describe("ConversationStream", () => {
  let provider: FakeMessagingProvider;
  let stream: ConversationStream;
  const updates: { messageId: string; text: string }[] = [];

  beforeEach(() => {
    provider = new FakeMessagingProvider();
    spyOn(provider, "updateMessage").mockImplementation(async (_conversationId, messageId, text) => {
      updates.push({ messageId, text });
      return messageId;
    });
    updates.length = 0;
    stream = new ConversationStream(provider, "C-eng", () => {});
  });

  it("posts a placeholder while the agent has produced nothing", async () => {
    await stream.flush();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.text).toContain("⏳");
  });

  it("edits the message it already posted as the response grows", async () => {
    stream.append("hello");
    await stream.flush();
    stream.append(" there");
    await stream.flush();

    expect(provider.sent.map(message => message.text)).toEqual(["hello"]);
    expect(updates).toEqual([{ messageId: "m1", text: "hello there" }]);
  });

  it("posts a new message once the response outgrows the platform limit", async () => {
    stream.append("a".repeat(30));
    await stream.flush();

    expect(provider.sent.map(message => message.text.length)).toEqual([20, 10]);
  });

  it("posts every chunk into the thread it was told to answer in", async () => {
    stream = new ConversationStream(provider, "C-eng", () => {}, { replyToMessageId: "t1" });
    stream.append("a".repeat(30));
    await stream.flush();

    expect(provider.sent.map(message => message.replyTo)).toEqual(["t1", "t1"]);
  });
});
