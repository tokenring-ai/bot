import EnhancedSet from "@tokenring-ai/utility/set/enhancedSet";
import type BotService from "./BotService.ts";
import type { CommunicationChannel } from "./CommunicationChannel.ts";

/**
 * Opens one channel per group member and presents them as a single channel:
 * anything sent goes to everyone, and anything anyone says is relayed to the
 * rest of the group as well as yielded to the caller.
 */
export async function createGroupChannel(
  botService: BotService,
  groupName: string,
  members: string[],
  visitedGroups: ReadonlySet<string>,
): Promise<CommunicationChannel> {
  const seen = new Set(visitedGroups).add(groupName);

  const channels: { target: string; channel: CommunicationChannel }[] = [];
  for (const target of members) {
    channels.push({ target, channel: await botService.openChannel(target, seen) });
  }

  const abortController = new AbortController();

  return {
    send: async (message: string) => {
      await Promise.all(channels.map(c => c.channel.send(message)));
    },
    receive: async function* () {
      const producers = channels.map(async function* ({ target, channel }) {
        for await (const incoming of channel.receive()) {
          if (abortController.signal.aborted) return;

          // Relay to the rest of the group so members see each other's replies
          const relayed = `@${target} ${incoming}`;
          const others = channels.filter(c => c.target !== target);
          await Promise.all(others.map(c => c.channel.send(relayed)));

          yield incoming;
        }
      });

      const activeProducers = new EnhancedSet(producers.map(p => p[Symbol.asyncIterator]()));

      while (activeProducers.size > 0 && !abortController.signal.aborted) {
        const nexts = activeProducers.map(it => it.next().then(res => ({ it, res })));
        const { it, res } = await Promise.race(nexts);

        if (res.done) {
          activeProducers.delete(it);
        } else {
          yield res.value;
        }
      }
    },
    [Symbol.asyncDispose]: async () => {
      abortController.abort();
      await Promise.all(
        channels.map(async ({ channel }) => {
          if (Symbol.dispose in channel) {
            channel[Symbol.dispose]();
          }
          if (Symbol.asyncDispose in channel) {
            await channel[Symbol.asyncDispose]();
          }
        }),
      );
    },
  };
}
