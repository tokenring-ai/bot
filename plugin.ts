import { AgentCommandService } from "@tokenring-ai/agent";
import type { TokenRingPlugin } from "@tokenring-ai/app";
import { RpcService } from "@tokenring-ai/rpc";
import { z } from "zod";
import BotService from "./BotService.ts";
import agentCommands from "./commands.ts";
import packageJSON from "./package.json" with { type: "json" };
import botRPC from "./rpc/bot.ts";
import { BotServiceConfigSchema } from "./schema.ts";

const packageConfigSchema = z.object({
  bot: BotServiceConfigSchema.prefault({}),
});

export default {
  name: packageJSON.name,
  displayName: "Bots",
  version: packageJSON.version,
  description: packageJSON.description,
  async install(app) {
    app.addService(new BotService(app));
    app.waitForService(AgentCommandService, agentCommandService => agentCommandService.addAgentCommands(agentCommands));
    app.waitForService(RpcService, rpcService => rpcService.registerEndpoint(botRPC));
  },
  async reconfigure(app, config) {
    await app.requireService(BotService).reconfigure(config.bot);
  },
  configSchema: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;
