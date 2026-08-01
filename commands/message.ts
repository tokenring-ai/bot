import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import BotService from "../BotService.ts";
import type { CommunicationChannel } from "../CommunicationChannel.ts";

const description = "Send a message to a user, channel, or group";

const inputSchema = {
  args: {},
  positionals: [
    {
      name: "target",
      description: "Target in service:userId format (e.g., slack:U123ABC, telegram:123456, group:dev-team)",
      required: true,
    },
  ],
  remainder: {
    name: "message",
    description: "Message to send",
    required: true,
  },
} as const satisfies AgentCommandInputSchema;

async function execute({ args: { target }, remainder, agent }: AgentCommandInputType<typeof inputSchema>): Promise<string> {
  const botService = agent.requireService(BotService);
  await using channel: CommunicationChannel = await botService.openChannel(target);
  await channel.send(remainder);
  return `Message sent to ${target}.`;
}

const help = `Send a message to a user, channel, or group on any connected messaging platform.

## Usage

/message {service:userId|group:groupName} {message}

## Example

/message slack:U123ABC Production server experiencing high latency
/message telegram:123456789 Project deadline extension request
/message group:dev-team Need code review for authentication module`;

export default {
  name: "message",
  help,
  description,
  inputSchema,
  execute,
} satisfies TokenRingAgentCommand<typeof inputSchema>;
