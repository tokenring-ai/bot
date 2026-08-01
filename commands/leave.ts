import { CommandFailedError } from "@tokenring-ai/agent/AgentError";
import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import BotService from "../BotService.ts";

const description = "Remove a bot from a group or channel";

const inputSchema = {
  args: {},
  positionals: [
    { name: "bot", description: "Name of the bot to remove the channel from", required: true },
    { name: "target", description: "Channel to leave, as service:channelId", required: true },
  ],
} as const satisfies AgentCommandInputSchema;

async function execute({ args: { bot, target }, agent }: AgentCommandInputType<typeof inputSchema>): Promise<string> {
  const botService = agent.requireService(BotService);

  const result = await botService.leaveChannel(bot, target);
  if (!result.ok) {
    throw new CommandFailedError(result.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
  }

  return `Bot "${bot}" left ${target}.`;
}

const help = `Remove a channel from a bot's configuration so it stops answering there.

The bot stays a member of the room on the platform — this only stops it
listening. Remove it from the group itself if you want it gone entirely.

## Usage

/bots leave {bot} {service:channelId}

## Example

/bots leave helper telegram:-1001234567890`;

export default {
  name: "bots leave",
  help,
  description,
  inputSchema,
  execute,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
