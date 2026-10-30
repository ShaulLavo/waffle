import { RootWatchAccount, type WatchAllocation } from "./watch-account.js";
import type { WatchGrowth } from "./watch-arena.js";

const WIDTH = 24;
const WORD = (1n << 64n) - 1n;
export function watchId(view: DataView, at: number): bigint {
  return view.getBigUint64(at, true) | (view.getBigUint64(at + 8, true) << 64n);
}
export function setWatchId(view: DataView, at: number, id: bigint): void {
  view.setBigUint64(at, id & WORD, true);
  view.setBigUint64(at + 8, id >> 64n, true);
}
function hash(id: bigint): number {
  let value = 2166136261;
  for (let word = 0; word < 4; word++) {
    value = Math.imul(value ^ Number(id & 0xffffffffn), 16777619);
    id >>= 32n;
  }
  return (value ^ (value >>> 16)) >>> 0;
}
const vacant = () => false;
function bucket(
  view: DataView,
  count: number,
  id: bigint,
  matches?: (slot: number) => boolean,
): number {
  const start = hash(id) % count;
  let deleted = -1;
  for (let step = 0; step < count; step++) {
    const at = ((start + step) % count) * WIDTH;
    const state = view.getUint32(at + 20, true);
    if (!state) return deleted < 0 ? at : deleted;
    if (state === 2 && deleted < 0) deleted = at;
    if (
      state === 1 &&
      watchId(view, at) === id &&
      (!matches || matches(view.getUint32(at + 16, true)))
    )
      return at;
  }
  if (deleted >= 0) return deleted;
  throw new Error("watch identity table has no free bucket");
}
function insert(view: DataView, count: number, id: bigint, slot: number): void {
  const at = bucket(view, count, id, vacant);
  setWatchId(view, at, id);
  view.setUint32(at + 16, slot, true);
  view.setUint32(at + 20, 1, true);
}

export class WatchIdIndex {
  private pending = false;
  private allocation: WatchAllocation | undefined;
  private buckets = 0;
  private count = 0;
  private deleted = 0;
  private rehashes = 0;
  constructor(private readonly account: RootWatchAccount) {}
  resources() {
    return {
      buckets: this.buckets,
      identities: this.count,
      tombstones: this.deleted,
      rehashes: this.rehashes,
    };
  }
  get(id: bigint, matches?: (slot: number) => boolean): number {
    if (!this.allocation) return 0;
    const view = this.allocation.view;
    const at = bucket(view, this.buckets, id, matches);
    return view.getUint32(at + 20, true) === 1 ? view.getUint32(at + 16, true) : 0;
  }
  stage(): WatchGrowth {
    if (this.pending) throw new Error("watch identity rehash is already staged");
    if ((this.count + 1) * 2 <= this.buckets && this.deleted * 4 <= this.buckets)
      return { commit() {}, cancel() {} };
    const count = Math.max(this.buckets, 2 ** Math.ceil(Math.log2(2 * (this.count + 1))));
    const next = this.account.reserve(count * WIDTH);
    try {
      this.copy(next.view, count);
    } catch (error) {
      next.cancel();
      throw error;
    }
    let pending = true;
    this.pending = true;
    return {
      commit: () => {
        if (!pending) return;
        pending = false;
        this.pending = false;
        const old = this.allocation;
        this.allocation = next.commit();
        this.buckets = count;
        this.deleted = 0;
        this.rehashes++;
        old?.release();
      },
      cancel: () => {
        if (!pending) return;
        pending = false;
        this.pending = false;
        next.cancel();
      },
    };
  }
  private copy(view: DataView, buckets: number): void {
    if (!this.allocation) return;
    const old = this.allocation.view;
    for (let index = 0; index < this.buckets; index++) {
      const at = index * WIDTH;
      if (old.getUint32(at + 20, true) !== 1) continue;
      insert(view, buckets, watchId(old, at), old.getUint32(at + 16, true));
    }
  }
  add(id: bigint, slot: number): void {
    const view = this.allocation!.view;
    const at = bucket(view, this.buckets, id, vacant);
    if (view.getUint32(at + 20, true) === 2) this.deleted--;
    insert(view, this.buckets, id, slot);
    this.count++;
  }
  set(id: bigint, slot: number): void {
    if (!this.allocation) throw new Error("watch lookup is empty");
    const at = bucket(this.allocation.view, this.buckets, id);
    if (this.allocation.view.getUint32(at + 20, true) !== 1)
      throw new Error("watch lookup key is absent");
    this.allocation.view.setUint32(at + 16, slot, true);
  }
  delete(id: bigint, matches?: (slot: number) => boolean): void {
    if (!this.allocation) return;
    const view = this.allocation.view;
    const at = bucket(view, this.buckets, id, matches);
    if (view.getUint32(at + 20, true) !== 1) return;
    view.setUint32(at + 20, 2, true);
    this.deleted++;
    this.count--;
  }
  close(): void {
    this.allocation?.release();
    this.allocation = undefined;
    this.buckets = this.count = this.deleted = 0;
  }
}
