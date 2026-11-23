import {
  MapConstructor,
  arrayAppend,
  mapClear,
  mapDelete,
  mapGet,
  mapHas,
  mapSet,
  mapSize,
} from "../proc/intrinsics.js";

/** Answers that stay valid until the namespace epoch next changes. Each entry is served only at
 * the epoch it was answered in, and the epoch only moves forward, so a newer epoch makes every
 * older entry unreachable and they are dropped together. Within one epoch the cache is bounded
 * and drops its oldest entry first, rather than discarding a working set larger than the bound.
 *
 * Answers can name capabilities, so the cache is private authority: it touches its map only
 * through captured methods and keeps insertion order in an owned ring instead of iterating. */
export class EpochCache<K, V> {
  private readonly entries = new MapConstructor<K, V>();
  /** Keys in insertion order, oldest at `oldest` once the ring is full. Entries are own. */
  private readonly order: K[] = [];
  private oldest = 0;
  private epoch: number | undefined;
  constructor(private readonly limit: number) {}
  get(key: K, epoch: number): V | undefined {
    return epoch === this.epoch ? mapGet(this.entries, key) : undefined;
  }
  set(key: K, value: V, epoch: number): void {
    if (epoch !== this.epoch) {
      this.clear();
      this.epoch = epoch;
    }
    if (!mapHas(this.entries, key)) this.admit(key);
    mapSet(this.entries, key, value);
  }
  clear(): void {
    mapClear(this.entries);
    this.order.length = 0;
    this.oldest = 0;
    this.epoch = undefined;
  }
  private admit(key: K): void {
    if (mapSize(this.entries) < this.limit) {
      arrayAppend(this.order, key);
      return;
    }
    mapDelete(this.entries, this.order[this.oldest]!);
    this.order[this.oldest] = key;
    this.oldest = (this.oldest + 1) % this.limit;
  }
}
