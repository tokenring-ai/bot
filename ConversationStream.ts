import getRandomItem from "@tokenring-ai/utility/string/getRandomItem";
import workingMessages from "@tokenring-ai/utility/string/workingMessages";
import type { MessagingProvider, SendOptions } from "./MessagingProvider.ts";
import { splitIntoChunks } from "./splitIntoChunks.ts";

/**
 * One agent response as it appears in a conversation: text accumulates, and
 * each flush edits the messages already posted and posts any new ones the text
 * has grown into.
 */
export default class ConversationStream {
  private text: string | null = null;
  private messageIds: (string | undefined)[] = [];
  private sentTexts: string[] = [];
  private complete = false;

  constructor(
    private readonly provider: MessagingProvider,
    private readonly conversationId: string,
    private readonly onError: (error: unknown) => void,
    /** Where to post, when the response belongs somewhere narrower than the
     * conversation — a Slack thread, or a Telegram reply to the message asked. */
    private readonly sendOptions?: SendOptions,
  ) {}

  get isComplete(): boolean {
    return this.complete;
  }

  append(content: string): void {
    this.text = this.text === null ? content.trimStart() : this.text + content;
  }

  markComplete(): void {
    this.complete = true;
  }

  async flush(): Promise<void> {
    const chunks = this.text === null ? [`***${getRandomItem(workingMessages)}... ⏳***`] : splitIntoChunks(this.text, this.provider.maxMessageLength);

    // While streaming, resend the last chunk we sent (it may have grown) plus
    // everything after it. Once complete, reconcile every chunk.
    const syncFrom = this.complete ? 0 : Math.max(0, this.sentTexts.length - 1);

    for (let i = syncFrom; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (chunk === this.sentTexts[i]) continue;

      try {
        const existingId = this.messageIds[i];
        this.messageIds[i] = existingId
          ? await this.provider.updateMessage(this.conversationId, existingId, chunk)
          : await this.provider.sendMessage(this.conversationId, chunk, this.sendOptions);
        this.sentTexts[i] = chunk;
      } catch (error: unknown) {
        this.onError(error);
      }
    }
  }
}
