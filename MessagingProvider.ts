import type { ChatAttachment } from "@tokenring-ai/agent/AgentEvents";
import type { MaybePromise } from "bun";

/**
 * A message that arrived on some platform, normalized so that BotService can
 * route it without knowing which platform it came from.
 */
export type IncomingMessage = {
  /** Platform id of the conversation (channel, group, or 1:1 chat) it arrived in. */
  conversationId: string;
  /**
   * Platform id of the room the conversation lives inside, when the conversation
   * is a thread within a larger room — a Telegram forum topic. Channel
   * configuration and membership are matched against the room, so a bot joins a
   * forum once; the agent belongs to the thread, so topics do not share history.
   * Left unset when the conversation *is* the room, which is the common case.
   */
  roomId?: string | undefined;
  /** Platform id of the sender, without the service prefix. */
  userId: string;
  /** Display name of the sender, used to introduce them to the agent. */
  userName?: string | undefined;
  /** Message body, with any mention of the bot already stripped. */
  text: string;
  /** Platform id of this message, where the platform gives messages ids. */
  messageId?: string | undefined;
  /** Platform id of the message this one replies to, when it is a reply. */
  replyToMessageId?: string | undefined;
  /** Whether the message carries files — answerable without fetching them. */
  hasAttachments: boolean;
  /**
   * Fetches the message's files. Downloading is deferred to here so a message
   * nobody handles — the overwhelming majority in a busy group — costs nothing.
   * Called only after a bot has claimed the message.
   */
  attachments?: (() => MaybePromise<ChatAttachment[]>) | undefined;
  /** True for a private 1:1 chat with the bot, false for a group or channel. */
  direct: boolean;
  /** True when the bot was addressed directly — mentioned, or replied to. */
  addressed: boolean;
};

export type IncomingMessageHandler = (message: IncomingMessage) => MaybePromise<void>;

/** Per-message options a caller may attach when posting. */
export type SendOptions = {
  /** Post as a reply to this message, where the platform supports threading. */
  replyToMessageId?: string | undefined;
};

/** The bot being added to, or removed from, a room it did not configure itself into. */
export type ChannelMembership = {
  /** Platform id of the room. */
  conversationId: string;
  /** Human readable room name, when the platform provides one. */
  title?: string | undefined;
  /** True when the bot was added, false when it was removed or kicked. */
  joined: boolean;
  /** Platform id of whoever added or removed it, when the platform says. */
  byUserId?: string | undefined;
  /**
   * How we found out. `invite` is the platform telling us the membership just
   * changed, and `byUserId` is who changed it. `observed` is us noticing traffic
   * from a room we were already in — the room is worth reporting, but nobody
   * invited us just now, so it must never trigger an automatic join.
   */
  via: "invite" | "observed";
};

export type MembershipHandler = (event: ChannelMembership) => MaybePromise<void>;

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

  /**
   * Registers a callback for the bot being added to or removed from a room.
   * Optional: only platforms that report membership implement it.
   */
  onMembershipChange?(handler: MembershipHandler): void;

  /** Posts a new message, returning its platform message id. */
  sendMessage(conversationId: string, text: string, options?: SendOptions): Promise<string>;

  /** Edits a message in place, returning the id it now lives under. */
  updateMessage(conversationId: string, messageId: string, text: string): Promise<string>;

  /**
   * Conversation id to use when talking to a target id — the id itself for a
   * channel, or the 1:1 chat with a user, opening one if the platform needs it.
   */
  resolveConversation(targetId: string): MaybePromise<string>;
}
