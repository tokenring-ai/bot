import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import AgentManager from "@tokenring-ai/agent/services/AgentManager";
import createTestingAgent from "@tokenring-ai/agent/test/createTestingAgent.test";
import type TokenRingApp from "@tokenring-ai/app";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import Bot from "./Bot.ts";
import BotService from "./BotService.ts";
import ConversationStream from "./ConversationStream.ts";
import type { IncomingMessage, IncomingMessageHandler, MessagingProvider } from "./MessagingProvider.ts";
import botRPC from "./rpc/bot.ts";
import { BotServiceConfigSchema } from "./schema.ts";

class FakeMessagingProvider implements MessagingProvider {
  readonly maxMessageLength = 20;
  sent: { conversationId: string; text: string }[] = [];
  private handlers: IncomingMessageHandler[] = [];

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  async sendMessage(conversationId: string, text: string): Promise<string> {
    this.sent.push({ conversationId, text });
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
      ...message,
    };
    return Promise.all(this.handlers.map(async handler => handler(full)));
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

  async function buildService(overrides: Record<string, unknown> = {}) {
    const config = BotServiceConfigSchema.parse({
      bots: { helper: { ...botConfig, ...overrides } },
      groups: { "dev-team": ["chat:U-admin", "chat:U-member"] },
    });

    provider = new FakeMessagingProvider();
    botService = new BotService(app);
    await botService.reconfigure(config);
    botService.registerBot("helper", new Bot(app, botService, "helper", config.bots.helper!));
    botService.registerProvider("chat", provider);
  }

  beforeEach(async () => {
    mock.clearAllMocks();

    app = createTestingApp();
    const agentManager = new AgentManager(app);
    app.addServices(agentManager);

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
    buildService({ directMessages: "anyone" });

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

    it("broadcasts to every member of a group", async () => {
      await botService.sendMessage("group:dev-team", "standup");

      expect(provider.sent.map(message => message.conversationId).sort()).toEqual(["D-U-admin", "D-U-member"]);
    });

    it("rejects targets that are not service:id", () => {
      expect(botService.sendMessage("nonsense", "hi")).rejects.toThrow("Invalid target");
    });
  });

  describe("RPC", () => {
    beforeEach(() => {
      app.addServices(botService);
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
});
