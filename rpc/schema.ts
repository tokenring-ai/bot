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

export const BotNotFoundSchema = z.object({
  status: z.literal("botNotFound"),
});

export const ConversationNotFoundSchema = z.object({
  status: z.literal("conversationNotFound"),
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
  },
} satisfies RPCSchema;
