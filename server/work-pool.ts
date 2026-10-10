/** Bounded FIFO permits. An aborted waiter never starts work or consumes a permit. */
export class WorkPool {
  readonly limit: number;
  private active = 0;
  private waiting: { start: () => void; cancel: () => void; signal: AbortSignal }[] = [];
  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Worker limit must be between 1 and 8.');
    this.limit = limit;
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { signal, start: () => {
        signal.removeEventListener('abort', entry.cancel);
        this.active++;
        let released = false;
        resolve(() => { if (released) return; released = true; this.active--; this.drain(); });
      }, cancel: () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(signal.reason); this.drain();
      } };
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.waiting.push(entry); this.drain();
    });
  }
  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const entry = this.waiting.shift()!;
      if (entry.signal.aborted) entry.cancel(); else entry.start();
    }
  }
}
