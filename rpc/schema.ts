import type { RPCSchema } from "@tokenring-ai/rpc/types";
import { ProviderNotFoundSchema, SuccessSchema } from "@tokenring-ai/rpc/types";
import { z } from "zod";
import { BotUserRoleSchema } from "../schema.ts";

export const BotUserSchema = z.object({
  /** `service:userId` */
  target: z.string(),
  service: z.string(),
  userId: z.string(),
  role: BotUserRoleSchema,
});

export const BotChannelSchema = z.object({
  name: z.string(),
  /** `service:channelId` */
  target: z.string(),
  service: z.string(),
  channelId: z.string(),
  agentType: z.string(),
  allowedUsers: z.array(z.string()),
  /** True when the channel's messaging service is connected. */
  connected: z.boolean(),
});

export const BotConversationSchema = z.object({
  key: z.string(),
  service: z.string(),
  conversationId: z.string(),
  agentId: z.string(),
  agentType: z.string(),
  channelName: z.string().exactOptional(),
  startedAt: z.number(),
  lastActivityAt: z.number(),
  busy: z.boolean(),
});

export const BotSummarySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  agentType: z.string(),
  directMessages: z.enum(["listed", "anyone", "none"]),
  requireMention: z.boolean(),
  joinMessage: z.string().exactOptional(),
  users: z.array(BotUserSchema),
  channels: z.array(BotChannelSchema),
  conversations: z.array(BotConversationSchema),
});

export const MessagingServiceSchema = z.object({
  name: z.string(),
  maxMessageLength: z.number(),
});

export const BotGroupSchema = z.object({
  name: z.string(),
  members: z.array(z.string()),
});

/** A room the bot is in that no bot has been configured into yet. */
export const DiscoveredChannelSchema = z.object({
  /** `service:channelId` */
  target: z.string(),
  service: z.string(),
  channelId: z.string(),
  title: z.string().exactOptional(),
  discoveredAt: z.number(),
  /** `service:userId` of whoever added the bot, when the platform said. */
  invitedBy: z.string().exactOptional(),
});

export const BotNotFoundSchema = z.object({
  status: z.literal("botNotFound"),
});

export const BotExistsSchema = z.object({
  status: z.literal("botExists"),
});

/**
 * The write succeeded but the thing is still there, because a configuration
 * layer below the one bots write to defines it. Layers merge, so there is no
 * value that unsays a lower layer — it has to be edited where it lives.
 */
export const DefinedElsewhereSchema = z.object({
  status: z.literal("definedElsewhere"),
});

export const ConversationNotFoundSchema = z.object({
  status: z.literal("conversationNotFound"),
});

/** The running app rejected the configuration this change would have produced. */
export const ConfigRejectedSchema = z.object({
  status: z.literal("configRejected"),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })),
});

export default {
  name: "Bot RPC",
  path: "/rpc/bot",
  methods: {
    listBots: {
      type: "query",
      input: z.object({}),
      result: SuccessSchema.extend({
        bots: z.array(BotSummarySchema),
        services: z.array(MessagingServiceSchema),
        groups: z.array(BotGroupSchema),
        discoveredChannels: z.array(DiscoveredChannelSchema),
      }),
    },
    sendMessage: {
      type: "mutation",
      input: z.object({
        /** `service:userId`, `service:channelId`, or `group:name` */
        target: z.string().min(1),
        message: z.string().min(1),
      }),
      result: z.discriminatedUnion("status", [SuccessSchema, ProviderNotFoundSchema]),
    },
    resetConversation: {
      type: "mutation",
      input: z.object({
        bot: z.string().min(1),
        conversationKey: z.string().min(1),
      }),
      result: z.discriminatedUnion("status", [SuccessSchema, BotNotFoundSchema, ConversationNotFoundSchema]),
    },
    createBot: {
      type: "mutation",
      input: z.object({
        name: z
          .string()
          .min(1)
          .regex(/^[a-zA-Z0-9_-]+$/, "A bot name may use letters, numbers, dashes and underscores"),
        agentType: z.string().min(1),
        displayName: z.string().min(1).exactOptional(),
        directMessages: z.enum(["listed", "anyone", "none"]).exactOptional(),
        requireMention: z.boolean().exactOptional(),
        joinPolicy: z.enum(["manual", "whenInvitedByAdmin", "whenInvited"]).exactOptional(),
        joinMessage: z.string().min(1).exactOptional(),
        /** Seeds `users` so the new bot has somebody who may talk to it. */
        users: z.record(z.string(), BotUserRoleSchema).exactOptional(),
      }),
      result: z.discriminatedUnion("status", [SuccessSchema, BotExistsSchema, ConfigRejectedSchema]),
    },
    deleteBot: {
      type: "mutation",
      input: z.object({ name: z.string().min(1) }),
      result: z.discriminatedUnion("status", [SuccessSchema, BotNotFoundSchema, DefinedElsewhereSchema, ConfigRejectedSchema]),
    },
    setUserRole: {
      type: "mutation",
      input: z.object({
        bot: z.string().min(1),
        /** `service:userId` */
        target: z.string().min(1),
        role: BotUserRoleSchema,
      }),
      result: z.discriminatedUnion("status", [SuccessSchema, BotNotFoundSchema, ConfigRejectedSchema]),
    },
    removeUser: {
      type: "mutation",
      input: z.object({
        bot: z.string().min(1),
        /** `service:userId` */
        target: z.string().min(1),
      }),
      result: z.discriminatedUnion("status", [SuccessSchema, BotNotFoundSchema, DefinedElsewhereSchema, ConfigRejectedSchema]),
    },
    joinChannel: {
      type: "mutation",
      input: z.object({
        bot: z.string().min(1),
        /** `service:channelId` */
        target: z.string().min(1),
        name: z.string().min(1).exactOptional(),
      }),
      result: z.discriminatedUnion("status", [SuccessSchema, BotNotFoundSchema, ProviderNotFoundSchema, ConfigRejectedSchema]),
    },
    leaveChannel: {
      type: "mutation",
      input: z.object({
        bot: z.string().min(1),
        /** `service:channelId` */
        target: z.string().min(1),
      }),
      result: z.discriminatedUnion("status", [SuccessSchema, BotNotFoundSchema, DefinedElsewhereSchema, ConfigRejectedSchema]),
    },
  },
} satisfies RPCSchema;
