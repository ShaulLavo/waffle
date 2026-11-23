/** Answers that stay valid until the namespace epoch next changes. Each entry is served only at
 * the epoch it was answered in, and the epoch only moves forward, so a newer epoch makes every
 * older entry unreachable and they are dropped together. Within one epoch the cache is bounded
 * and drops its oldest entry first, rather than discarding a working set larger than the bound. */
export class EpochCache<K, V> {
  private readonly entries = new Map<K, V>();
  private epoch: number | undefined;
  constructor(private readonly limit: number) {}
  get(key: K, epoch: number): V | undefined {
    return epoch === this.epoch ? this.entries.get(key) : undefined;
  }
  set(key: K, value: V, epoch: number): void {
    if (epoch !== this.epoch) {
      this.entries.clear();
      this.epoch = epoch;
    } else if (!this.entries.delete(key) && this.entries.size >= this.limit) {
      for (const oldest of this.entries.keys()) {
        this.entries.delete(oldest);
        break;
      }
    }
    this.entries.set(key, value);
  }
  clear(): void {
    this.entries.clear();
    this.epoch = undefined;
  }
}
