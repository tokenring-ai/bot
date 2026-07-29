import { CommandFailedError } from "@tokenring-ai/agent/AgentError";
import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import BotService from "../BotService.ts";

const description = "Add a bot to a group or channel it has been invited to";

const inputSchema = {
  args: {
    name: {
      description: "Name to file the channel under in the bot's configuration",
      type: "string",
    },
  },
  positionals: [
    { name: "bot", description: "Name of the bot to join", required: true },
    { name: "target", description: "Channel to join, as service:channelId (e.g. telegram:-1001234567890)", required: true },
  ],
} as const satisfies AgentCommandInputSchema;

async function execute({ positionals: { bot, target }, args: { name }, agent }: AgentCommandInputType<typeof inputSchema>): Promise<string> {
  const botService = agent.requireServiceByType(BotService);

  const result = await botService.joinChannel(bot, target, name);
  if (!result.ok) {
    throw new CommandFailedError(result.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
  }

  return `Bot "${bot}" joined ${target}.`;
}

const help = `Add a channel to a bot's configuration so it starts answering there.

A bot cannot add itself to a Telegram group — a person invites it, and the group
then shows up under "Discovered channels" in /bots. This command settles which
bot takes it. The channel is written to the config layer named by
\`bot.channelWriteScope\` (\`user\` by default) and takes effect without a restart.

## Usage

/bots join {bot} {service:channelId} [--name=ops]

## Example

/bots join helper telegram:-1001234567890
/bots join helper slack:C0123ABCD --name=engineering`;

export default {
  name: "bots join",
  help,
  description,
  inputSchema,
  execute,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
