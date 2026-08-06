import type { ConfigFieldMeta } from "@tokenring-ai/app/config/metadata";
import z from "zod";

/**
 * What a user may do with a bot. `user` may chat with it; `admin` may also run
 * slash commands against the agent behind it.
 */
export const BotUserRoleSchema = z.enum(["admin", "user"]);
export type BotUserRole = z.output<typeof BotUserRoleSchema>;

export const BotChannelConfigSchema = z.object({
  target: z
    .string()
    .meta({ label: "Target", description: "Group or channel to sit in, as service:channelId (e.g. slack:C0123ABCD)" } satisfies ConfigFieldMeta),
  agentType: z
    .string()
    .exactOptional()
    .meta({ advanced: true, description: "Agent type for this channel, overriding the bot's own agent type" } satisfies ConfigFieldMeta),
  allowedUsers: z
    .array(z.string())
    .default([])
    .meta({ description: "Users who may address the bot here, as service:userId. Empty means anyone in the channel" } satisfies ConfigFieldMeta),
});

export type ParsedBotChannelConfig = z.output<typeof BotChannelConfigSchema>;

export const BotConfigSchema = z.object({
  agentType: z.string().meta({ label: "Agent Type", description: "Agent type that gives the bot its personality and permissions" } satisfies ConfigFieldMeta),
  displayName: z
    .string()
    .exactOptional()
    .meta({ description: "Human readable name for the bot" } satisfies ConfigFieldMeta),
  users: z
    .record(z.string(), BotUserRoleSchema)
    .default({})
    .meta({ label: "Users", description: "Users of the bot, keyed by service:userId, mapped to their role" } satisfies ConfigFieldMeta),
  channels: z
    .record(z.string(), BotChannelConfigSchema)
    .default({})
    .meta({ label: "Channels", description: "Groups and channels the bot joins, keyed by a name of your choosing" } satisfies ConfigFieldMeta),
  directMessages: z
    .enum(["listed", "anyone", "none"])
    .default("listed")
    .meta({ description: "Who may DM the bot: only listed users, anyone, or nobody" } satisfies ConfigFieldMeta),
  requireMention: z
    .boolean()
    .default(true)
    .meta({ advanced: true, description: "Only respond in channels when the bot is mentioned or replied to" } satisfies ConfigFieldMeta),
  joinMessage: z
    .string()
    .exactOptional()
    .meta({ description: "Message announced in each channel when the bot connects" } satisfies ConfigFieldMeta),
  joinPolicy: z
    .enum(["manual", "whenInvitedByAdmin", "whenInvited"])
    .default("manual")
    .meta({
      label: "Join Policy",
      description:
        "What happens when the bot is added to a group: wait to be joined by hand, join if an admin of this bot invited it, or join whoever invites it",
    } satisfies ConfigFieldMeta),
  commandMapping: z
    .record(z.string(), z.string())
    .default({ "/reset": "/chat reset" })
    .meta({ advanced: true, description: "Platform commands mapped to agent commands" } satisfies ConfigFieldMeta),
});

export type ParsedBotConfig = z.output<typeof BotConfigSchema>;

export const BotServiceConfigSchema = z
  .object({
    bots: z
      .record(z.string(), BotConfigSchema)
      .default({})
      .meta({ label: "Bots", description: "Bots to run, keyed by name" } satisfies ConfigFieldMeta),
    groups: z
      .record(z.string(), z.array(z.string()))
      .default({})
      .meta({ label: "Groups", description: "Broadcast groups, keyed by name, listing service:userId members" } satisfies ConfigFieldMeta),
    channelWriteScope: z
      .enum(["global", "workspace"])
      .default("workspace")
      .meta({
        advanced: true,
        description: "Config layer that joined channels are written to, whether joined automatically or by command",
      } satisfies ConfigFieldMeta),
  })
  .meta({ label: "Bots", description: "Channel agnostic bots and the people they talk to" } satisfies ConfigFieldMeta);

export type ParsedBotServiceConfig = z.output<typeof BotServiceConfigSchema>;
