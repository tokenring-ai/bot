import { AgentCommandService } from "@tokenring-ai/agent";
import type { TokenRingPlugin } from "@tokenring-ai/app";
import { z } from "zod";
import agentCommands from "./commands.ts";
import EscalationService from "./EscalationService.ts";
import GroupEscalationProvider from "./GroupEscalationProvider.ts";
import packageJSON from "./package.json" with { type: "json" };
import { EscalationServiceConfigSchema } from "./schema.ts";

const packageConfigSchema = z.object({
  escalation: EscalationServiceConfigSchema.exactOptional(),
});

export default {
  name: packageJSON.name,
  displayName: "Escalation Service",
  version: packageJSON.version,
  description: packageJSON.description,
  install(app, config) {
    if (config.escalation) {
      const service = new EscalationService(config.escalation);
      app.addServices(service);

      for (const [groupName, groupConfig] of Object.entries(config.escalation.groups)) {
        service.registerProvider(groupName, new GroupEscalationProvider(groupConfig));
      }

      app.waitForService(AgentCommandService, agentCommandService => agentCommandService.addAgentCommands(agentCommands));
    }
  },
  configSchema: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;
