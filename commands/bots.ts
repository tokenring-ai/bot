import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import BotService from "../BotService.ts";

const description = "List the configured bots and the platforms they are reachable on";

const inputSchema = {} as const satisfies AgentCommandInputSchema;

function execute({ agent }: AgentCommandInputType<typeof inputSchema>): string {
  const botService = agent.requireServiceByType(BotService);

  const services = botService.getProviderNames();
  const lines: string[] = [`Connected messaging services: ${services.length > 0 ? services.join(", ") : "none"}`];

  const bots = botService.getBots();
  if (bots.length === 0) {
    lines.push("No bots configured.");
    return lines.join("\n");
  }

  for (const bot of bots) {
    lines.push("", `${bot.displayName} (${bot.name}) — agent type: ${bot.config.agentType}`);

    const channels = bot.channelTargets();
    lines.push(`  Channels: ${channels.length > 0 ? channels.join(", ") : "none"}`);

    const users = Object.entries(bot.config.users).map(([target, role]) => `${target} (${role})`);
    lines.push(`  Users: ${users.length > 0 ? users.join(", ") : "none"}`);
    lines.push(`  Direct messages: ${bot.config.directMessages}`);
  }

  const groups = Object.entries(botService.config.groups);
  if (groups.length > 0) {
    lines.push("", "Broadcast groups:");
    for (const [name, members] of groups) {
      lines.push(`  group:${name} — ${members.join(", ")}`);
    }
  }

  const discovered = botService.listDiscoveredChannels();
  if (discovered.length > 0) {
    lines.push("", "Discovered channels (no bot has joined these yet):");
    for (const channel of discovered) {
      const invited = channel.invitedBy ? `, invited by ${channel.invitedBy}` : "";
      lines.push(`  ${channel.target}${channel.title ? ` — ${channel.title}` : ""}${invited}`);
    }
    lines.push("", `Join one with: /bots join {bot} {target}`);
  }

  return lines.join("\n");
}

const help = `List the configured bots, the channels they sit in, and the users allowed to talk to them.

## Usage

/bots`;

export default {
  name: "bots",
  help,
  description,
  inputSchema,
  execute,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
