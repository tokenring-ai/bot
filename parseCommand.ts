export type ParsedCommand = { type: "mapped"; message: string } | { type: "stop" } | { type: "unknown"; command: string } | { type: "chat"; message: string };

/**
 * Interprets a message typed at a bot. Anything that isn't a slash command
 * becomes a `/chat send` with the sender attributed, so the agent knows who it
 * is talking to.
 */
export function parseCommand(text: string, commandMapping: Record<string, string>, from?: string): ParsedCommand {
  const commandMatch = text.match(/^\s*(\/\S+)(.*)/s);
  if (commandMatch) {
    const command = commandMatch[1]!;
    if (Object.hasOwn(commandMapping, command)) {
      return { type: "mapped", message: `${commandMapping[command]}${commandMatch[2]}` };
    }
    if (command === "/stop") {
      return { type: "stop" };
    }
    return { type: "unknown", command };
  }

  return {
    type: "chat",
    message: `/chat send From: ${from ?? "unknown user"} ${text || "No text sent"}`,
  };
}
