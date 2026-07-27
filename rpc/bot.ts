import type TokenRingApp from "@tokenring-ai/app";
import { createRPCEndpoint } from "@tokenring-ai/rpc/createRPCEndpoint";
import { stripUndefinedKeys } from "@tokenring-ai/utility/object/stripObject";
import type Bot from "../Bot.ts";
import BotService from "../BotService.ts";
import BotRpcSchema from "./schema.ts";

function toBotSummary(bot: Bot, botService: BotService) {
  const connectedServices = new Set(botService.getProviderNames());

  return stripUndefinedKeys({
    name: bot.name,
    displayName: bot.displayName,
    agentType: bot.config.agentType,
    directMessages: bot.config.directMessages,
    requireMention: bot.config.requireMention,
    joinMessage: bot.config.joinMessage,
    users: Object.entries(bot.config.users).map(([target, role]) => {
      const { service, id } = botService.parseTarget(target);
      return { target, service, userId: id, role };
    }),
    channels: Object.entries(bot.config.channels).map(([name, channel]) => {
      const { service, id } = botService.parseTarget(channel.target);
      return {
        name,
        target: channel.target,
        service,
        channelId: id,
        agentType: channel.agentType ?? bot.config.agentType,
        allowedUsers: channel.allowedUsers,
        connected: connectedServices.has(service),
      };
    }),
    conversations: bot.listConversations().map(conversation => stripUndefinedKeys(conversation)),
  });
}

export default createRPCEndpoint(BotRpcSchema, {
  listBots(_args, app: TokenRingApp) {
    const botService = app.requireService(BotService);

    return {
      status: "success" as const,
      bots: botService.getBots().map(bot => toBotSummary(bot, botService)),
      services: botService.getProviderNames().map(name => ({
        name,
        maxMessageLength: botService.requireProvider(name).maxMessageLength,
      })),
      groups: Object.entries(botService.config.groups).map(([name, members]) => ({ name, members })),
    };
  },

  async sendMessage(args, app: TokenRingApp) {
    const botService = app.requireService(BotService);

    const { service } = botService.parseTarget(args.target);
    if (service !== "group" && !botService.getProvider(service)) {
      return { status: "providerNotFound" as const };
    }

    await botService.sendMessage(args.target, args.message);
    return { status: "success" as const };
  },

  resetConversation(args, app: TokenRingApp) {
    const bot = app.requireService(BotService).getBot(args.bot);
    if (!bot) {
      return { status: "botNotFound" as const };
    }
    if (!bot.resetConversation(args.conversationKey)) {
      return { status: "conversationNotFound" as const };
    }
    return { status: "success" as const };
  },
});
