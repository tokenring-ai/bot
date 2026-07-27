import type { ChatAttachment } from "@tokenring-ai/agent/AgentEvents";
import type { MaybePromise } from "bun";

/**
 * A message that arrived on some platform, normalized so that BotService can
 * route it without knowing which platform it came from.
 */
export type IncomingMessage = {
  /** Platform id of the conversation (channel, group, or 1:1 chat) it arrived in. */
  conversationId: string;
  /** Platform id of the sender, without the service prefix. */
  userId: string;
  /** Display name of the sender, used to introduce them to the agent. */
  userName?: string | undefined;
  /** Message body, with any mention of the bot already stripped. */
  text: string;
  attachments?: ChatAttachment[] | undefined;
  /** True for a private 1:1 chat with the bot, false for a group or channel. */
  direct: boolean;
  /** True when the bot was addressed directly — mentioned, or replied to. */
  addressed: boolean;
};

export type IncomingMessageHandler = (message: IncomingMessage) => MaybePromise<void>;

/**
 * The transport half of a bot: everything platform specific, and nothing about
 * agents. Slack and Telegram each register one provider per account they hold
 * credentials for, and the name it is registered under is the `service` half of
 * a `service:userId` target.
 */
export interface MessagingProvider {
  /** Longest single message the platform accepts, used to chunk agent output. */
  readonly maxMessageLength: number;

  /** Registers the callback BotService routes inbound messages through. */
  onMessage(handler: IncomingMessageHandler): void;

  /** Posts a new message, returning its platform message id. */
  sendMessage(conversationId: string, text: string): Promise<string>;

  /** Edits a message in place, returning the id it now lives under. */
  updateMessage(conversationId: string, messageId: string, text: string): Promise<string>;

  /**
   * Conversation id to use when talking to a target id — the id itself for a
   * channel, or the 1:1 chat with a user, opening one if the platform needs it.
   */
  resolveConversation(targetId: string): MaybePromise<string>;
}
