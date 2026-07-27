import EnhancedSet from "@tokenring-ai/utility/set/enhancedSet";

/**
 * Collects items and hands them to a processor at most once per interval, so
 * that a token-by-token agent response turns into a manageable number of
 * message edits.
 */
export class ThrottledBatchProcessor<T> {
  private pending = new EnhancedSet<T>();
  private lastRunTime = 0;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly processItems: (items: T[]) => Promise<void>,
    private readonly intervalMs: number = 250,
  ) {}

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  add(item: T): void {
    this.pending.add(item);
    this.schedule();
  }

  async flush(): Promise<void> {
    await this.run();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const now = Date.now();
    const delay = Math.max(0, this.lastRunTime + this.intervalMs - now);
    this.timer = setTimeout(() => this.run(), delay);
  }

  private async run(): Promise<void> {
    if (this.isProcessing) return;

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.isProcessing = true;

    try {
      const items = this.pending.valuesArray();
      this.pending.clear();
      await this.processItems(items);
      this.lastRunTime = Date.now();
    } finally {
      this.isProcessing = false;
      this.timer = null;
      if (this.pending.size > 0) {
        this.schedule();
      }
    }
  }
}
