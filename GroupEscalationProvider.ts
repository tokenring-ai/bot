import type { Agent } from "@tokenring-ai/agent";
import EnhancedSet from "@tokenring-ai/utility/set/enhancedSet";
import type { z } from "zod";
import type { CommunicationChannel } from "./EscalationProvider.ts";
import { EscalationService } from "./index.ts";

import type { GroupEscalationProviderConfigSchema } from "./schema.ts";

export type EscalationProvider = {
  createCommunicationChannelWithUser: (userId: string, agent: Agent) => Promise<CommunicationChannel>;
};

export default class GroupEscalationProvider implements EscalationProvider {
  constructor(readonly config: z.output<typeof GroupEscalationProviderConfigSchema>) {}

  async createCommunicationChannelWithUser(groupId: string, agent: Agent): Promise<CommunicationChannel> {
    const escalationService = agent.requireServiceByType(EscalationService);

    const members = this.config.members[groupId] ?? null;
    if (!members) throw new Error("Invalid group ID: " + groupId + ".");

    const channels: { userOrGroupId: string; channel: CommunicationChannel }[] = [];

    for (const userOrGroupId of members) {
      //TODO: It is possible for the user to nest groups, which will likely cause problems

      channels.push({
        userOrGroupId,
        channel: await escalationService.initiateContactWithUser(userOrGroupId, agent),
      });
    }

    const abortController = new AbortController();

    return {
      send: async (msg: string) => {
        await Promise.all(channels.map(c => c.channel.send(msg)));
      },
      receive: async function* () {
        const producers = channels.map(async function* ({ userOrGroupId, channel }) {
          for await (const incomingMsg of channel.receive()) {
            if (abortController.signal.aborted) return;

            // Broadcast to other group members
            const broadcastMsg = `@${userOrGroupId} ${incomingMsg}`;
            const others = channels.filter(c => c.userOrGroupId !== userOrGroupId);
            await Promise.all(others.map(c => c.channel.send(broadcastMsg)));

            yield incomingMsg;
          }
        });

        // Merge all generators into one stream
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
          channels.map(async c => {
            if (Symbol.dispose in c.channel) {
              c.channel[Symbol.dispose]();
            }
            if (Symbol.asyncDispose in c.channel) {
              await c.channel[Symbol.asyncDispose]();
            }
          }),
        );
      },
    };
  }
}
