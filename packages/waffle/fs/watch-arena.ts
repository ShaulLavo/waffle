import {
  RootWatchAccount,
  type WatchAllocation,
  type WatchAllocationKind,
} from "./watch-account.js";

export interface WatchGrowth {
  commit(): void;
  cancel(): void;
}

export class WatchArena {
  private pending = false;
  private allocation: WatchAllocation | undefined;
  constructor(
    private readonly account: RootWatchAccount,
    private readonly kind: WatchAllocationKind = "metadata",
  ) {}
  get capacity(): number {
    return this.allocation?.length ?? 0;
  }
  get view(): DataView {
    if (!this.allocation) throw new Error("watch arena is empty");
    return this.allocation.view;
  }
  get bytes(): Uint8Array {
    if (!this.allocation) throw new Error("watch arena is empty");
    return this.allocation.array;
  }
  stage(bytes: number): WatchGrowth {
    if (this.pending) throw new Error("watch arena growth is already staged");
    if (bytes <= this.capacity) return { commit() {}, cancel() {} };
    const allocation = this.account.reserve(Math.max(bytes, this.capacity * 2), this.kind);
    if (this.allocation) allocation.array.set(this.allocation.array);
    let pending = true;
    this.pending = true;
    return {
      commit: () => {
        if (!pending) return;
        pending = false;
        this.pending = false;
        const old = this.allocation;
        this.allocation = allocation.commit();
        old?.release();
      },
      cancel: () => {
        if (!pending) return;
        pending = false;
        this.pending = false;
        allocation.cancel();
      },
    };
  }
  close(): void {
    this.allocation?.release();
    this.allocation = undefined;
  }
}
