/** Keep rollout scan-and-repair work off the interactive thread-list path. */
export class ThreadIndexReconciler {
  private pending = new Set<boolean>();
  private nextRefresh = new Map<boolean, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: boolean | undefined;
  private closed = false;

  constructor(private readonly options: {
    scan: (archived: boolean) => Promise<unknown>;
    updated: (archived: boolean) => void;
    failed: () => void;
    delayMs?: number;
    refreshMs?: number;
  }) {}

  request(archived: boolean, force = false): boolean {
    if (this.closed || this.running === archived || this.pending.has(archived)) return false;
    if (!force && Date.now() < (this.nextRefresh.get(archived) ?? 0)) return false;
    this.pending.add(archived);
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (this.closed || this.timer || this.running !== undefined || !this.pending.size) return;
    // Leave time for the first timeline request before starting the expensive
    // scan. Multiple tabs/refreshes share a single bounded background worker.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.options.delayMs ?? 2000);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    const archived = this.pending.values().next().value;
    if (this.closed || archived === undefined) return;
    this.pending.delete(archived);
    this.running = archived;
    try {
      await this.options.scan(archived);
      if (!this.closed) this.options.updated(archived);
    } catch {
      // A failed reconciliation must never fail a successful state-DB read or
      // trigger an immediate retry storm when several browsers are connected.
      if (!this.closed) this.options.failed();
    } finally {
      this.nextRefresh.set(archived, Date.now() + (this.options.refreshMs ?? 60_000));
      this.running = undefined;
      this.schedule();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
