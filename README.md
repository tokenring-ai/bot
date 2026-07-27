# @tokenring-ai/bot

## Overview

The `@tokenring-ai/bot` package runs **bots**: named assistants with a personality, a set of people allowed to talk to
them, and a presence in any number of chat rooms across any number of messaging platforms. A single bot can sit in a
Telegram group and a Slack channel at the same time, answer DMs from the people it knows, and start conversations of its
own when it needs an answer from a human.

The package owns everything that is *not* platform specific. Platform plugins — `@tokenring-ai/slack`,
`@tokenring-ai/telegram` — supply only a transport: how to send, edit, and receive messages. Bots know nothing about
Slack or Telegram, and transports know nothing about agents.

### How a bot is put together

- **Personality and permissions** come from the bot's `agentType`. Whatever that agent may do, the bot may do.
- **Users** are listed by `service:userId` and given a role: `admin` may run slash commands against the agent, `user`
  may only chat.
- **Channels** are the groups the bot joins, listed by `service:channelId`. A channel may override the agent type and
  restrict who may address the bot there.
- **One agent per conversation.** Each channel, and each user who DMs the bot, gets its own agent spawned from the
  bot's agent type, so conversations never bleed into each other.
- **Reaching out.** A bot can open a channel to any user or group and wait for their reply — used for approvals,
  reviews, and anything else that needs a human in the loop.

### Addressing

Everything is addressed as `service:id`, where `service` is the name a messaging account was registered under:

| Target                | Meaning                                            |
|-----------------------|----------------------------------------------------|
| `telegram:123456789`  | A Telegram user or group chat                      |
| `slack:U123ABC`       | A Slack user (a DM channel is opened as needed)    |
| `slack:C0123ABCD`     | A Slack channel                                    |
| `group:dev-team`      | A broadcast group defined in this plugin's config  |

## Installation

```bash
bun add @tokenring-ai/bot
```

## Configuration

```yaml
# Platform accounts live with their own plugin; the key names the service.
telegram:
  accounts:
    telegram:
      botToken: { source: env, env: TELEGRAM_BOT_TOKEN }
slack:
  accounts:
    slack:
      botToken: { source: env, env: SLACK_BOT_TOKEN }
      appToken: { source: env, env: SLACK_APP_TOKEN }
      signingSecret: { source: env, env: SLACK_SIGNING_SECRET }

bot:
  bots:
    helper:
      displayName: Helper
      agentType: assistant
      joinMessage: "Helper reporting for duty."
      users:
        "slack:U123ABC": admin
        "telegram:123456789": user
      channels:
        engineering:
          target: slack:C0123ABCD
        ops:
          target: telegram:-1001234567890
          agentType: ops-assistant
          allowedUsers: ["telegram:123456789"]
  groups:
    dev-team:
      - slack:U123ABC
      - telegram:123456789
```

### Bot options

| Option           | Type                                | Default                     | Description                                                            |
|------------------|-------------------------------------|-----------------------------|------------------------------------------------------------------------|
| `agentType`      | `string`                            | required                    | Agent type giving the bot its personality and permissions              |
| `displayName`    | `string`                            | bot name                    | Human readable name                                                    |
| `users`          | `Record<string, 'admin' \| 'user'>` | `{}`                        | Who may talk to the bot, keyed by `service:userId`                     |
| `channels`       | `Record<string, ChannelConfig>`     | `{}`                        | Groups and channels the bot joins                                      |
| `directMessages` | `'listed' \| 'anyone' \| 'none'`    | `'listed'`                  | Who may DM the bot                                                     |
| `requireMention` | `boolean`                           | `true`                      | Only answer in channels when mentioned or replied to                   |
| `joinMessage`    | `string`                            | —                           | Announced in each channel when the platform connects                   |
| `commandMapping` | `Record<string, string>`            | `{ "/reset": "/chat reset"}`| Platform commands mapped to agent commands                             |

### Channel options

| Option         | Type       | Default | Description                                                          |
|----------------|------------|---------|----------------------------------------------------------------------|
| `target`       | `string`   | required| The channel, as `service:channelId`                                  |
| `agentType`    | `string`   | bot's   | Agent type for this channel only                                     |
| `allowedUsers` | `string[]` | `[]`    | Users who may address the bot here. Empty means anyone in the channel |

### Access rules

- A DM is answered only if the sender is listed in `users`, or `directMessages` is `anyone`. Unrecognized senders are
  ignored in silence — the bot does not confirm that it exists.
- In a channel, anyone may address the bot unless `allowedUsers` is set; unauthorized users are told so.
- Slash commands (`/reset`, `/stop`, anything in `commandMapping`) are for `admin` users only. Everyone else's messages
  are passed to the agent as chat.

## Chat Commands

| Command    | Description                                              |
|------------|----------------------------------------------------------|
| `/message` | Send a message to a user, channel, or group              |
| `/bots`    | List the bots, their channels, and who may talk to them  |

```bash
/message slack:U123ABC Production server experiencing high latency
/message telegram:123456789 Project deadline extension request
/message group:dev-team Need code review for authentication module
```

## Tools

This package does not define any tools.

### ENV Variables

This package does not define any environment variables.

## License

MIT License - see LICENSE file for details.

---

## Developer Reference

### BotService

The registry where bots and messaging providers meet. It routes every inbound message to whichever bot owns the
conversation it arrived in: for a channel, the bot that joined it; for a DM, the bot that lists the sender.

| Method                                          | Description                                                        |
|-------------------------------------------------|--------------------------------------------------------------------|
| `registerProvider(service, provider)`           | Registers a platform account under the name that addresses it      |
| `unregisterProvider(service)`                   | Removes an account, e.g. on shutdown                               |
| `registerBot(name, bot)`                        | Adds a bot                                                         |
| `getBot(name)` / `requireBot(name)`             | Looks a bot up                                                     |
| `openChannel(target)`                           | Opens a two-way channel with a user, channel, or group             |
| `sendMessage(target, message)`                  | Sends a message without waiting for a reply                        |
| `parseTarget(target)`                           | Splits `service:id` into its parts                                 |

While a channel opened with `openChannel` is alive, replies in that conversation go to the channel rather than to the
agent that otherwise watches it, so an outreach and an ongoing chat cannot answer each other's messages.

### MessagingProvider

What a platform plugin implements. One provider per account — a Telegram bot token, a Slack app installation.

```typescript
export interface MessagingProvider {
  readonly maxMessageLength: number;
  onMessage(handler: IncomingMessageHandler): void;
  sendMessage(conversationId: string, text: string): Promise<string>;
  updateMessage(conversationId: string, messageId: string, text: string): Promise<string>;
  resolveConversation(targetId: string): MaybePromise<string>;
}
```

Inbound messages are normalized to a shape the service can route without knowing the platform:

```typescript
export type IncomingMessage = {
  conversationId: string;
  userId: string;
  userName?: string | undefined;
  text: string;                       // with any mention of the bot stripped
  attachments?: ChatAttachment[] | undefined;
  direct: boolean;                    // a 1:1 chat with the bot
  addressed: boolean;                 // mentioned, replied to, or in a DM
};
```

Registering an account is all a platform plugin has to do:

```typescript
const botService = app.requireService(BotService);
botService.registerProvider("slack", provider);
```

### CommunicationChannel

A two-way conversation, released through the dispose protocol:

```typescript
const botService = agent.requireServiceByType(BotService);
await using channel = await botService.openChannel("group:dev-team");

await channel.send("Ready to publish. Reply approve or reject.");
for await (const reply of channel.receive()) {
  if (reply.trim().toLowerCase() === "approve") break;
}
```

Group channels broadcast to every member and relay each member's replies to the rest of the group, prefixed with the
sender's target.

### Response streaming

Agent output is streamed back into the conversation by `ConversationStream`: text accumulates, is split into chunks that
fit `maxMessageLength`, and each flush edits the messages already posted and posts any new ones the response has grown
into. Flushes are throttled to at most once every 250ms per bot, so a token-by-token response does not turn into a
storm of edits.

### Package Structure

```text
plugin/bot/
├── index.ts                    # Main exports
├── plugin.ts                   # Plugin definition for TokenRing integration
├── BotService.ts               # Bot and provider registry, message routing
├── Bot.ts                      # A single bot: permissions, agents, conversations
├── MessagingProvider.ts        # Transport interface implemented by platform plugins
├── CommunicationChannel.ts     # Two-way channel type
├── ConversationStream.ts       # Streams an agent response into a conversation
├── groupChannel.ts             # Broadcast group channels
├── splitIntoChunks.ts          # Chunking to a platform's message limit
├── parseCommand.ts             # Slash command parsing
├── ThrottledBatchProcessor.ts  # Flush throttling
├── schema.ts                   # Configuration schemas
├── commands.ts                 # Command exports
├── commands/
│   ├── message.ts              # /message command
│   └── bots.ts                 # /bots command
└── LICENSE                     # MIT License
```

### Testing

```bash
bun test
```
