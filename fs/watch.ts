import { FilesystemError } from "../core/filesystem.js";
import type { FilesystemClient } from "./client.js";
import { isRevoked } from "./section.js";
import { atomicsLoad, atomicsWaitAsync } from "../proc/intrinsics.js";

export interface WatchOptions {
  readonly recursive?: boolean;
  readonly signal?: AbortSignal;
}
export interface WatchEvent {
  readonly type: "change" | "rename";
  readonly id: bigint;
  readonly name: string | null;
}
export type WatchBatch =
  | { readonly kind: "events"; readonly events: readonly WatchEvent[] }
  | { readonly kind: "overflow" | "closed"; readonly events: readonly [] };

/** Readiness is advisory. read() owns delivery; next() waits without polling or holding an RPC. */
export class FilesystemWatch {
  private closed = false;
  private waiting = false;
  private readonly abort = () => {
    void this.close().catch(() => {});
  };
  constructor(
    private readonly client: FilesystemClient,
    private readonly id: number,
    private readonly signal?: AbortSignal,
    private readonly onClose: (watcher: FilesystemWatch) => void = () => {},
  ) {
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  async read(): Promise<WatchBatch> {
    if (this.closed) return { kind: "closed", events: [] };
    if (isRevoked(this.client.connection)) {
      await this.close();
      throw new FilesystemError(11);
    }
    try {
      const batch: WatchBatch = await this.client.asyncCall("watchRead", [this.id]);
      return this.closed ? { kind: "closed", events: [] } : batch;
    } catch (error) {
      if (isRevoked(this.client.connection) && !this.closed) {
        await this.close();
        throw error;
      }
      if (this.closed) return { kind: "closed", events: [] };
      throw error;
    }
  }
  async next(): Promise<WatchBatch> {
    if (this.waiting) throw new FilesystemError(6, "watch already has a waiter");
    this.waiting = true;
    try {
      return await this.wait();
    } finally {
      this.waiting = false;
    }
  }
  private async wait(): Promise<WatchBatch> {
    const ring = this.client.shared.watch;
    for (;;) {
      const observed = atomicsLoad(ring.cells, 3);
      const batch = await this.read();
      if (batch.kind !== "events" || batch.events.length) return batch;
      const waiting = atomicsWaitAsync(ring.cells, 3, observed);
      if (this.closed || isRevoked(this.client.connection)) ring.wake();
      if (waiting.async) await waiting.value;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    this.client.shared.watch.wake();
    this.onClose(this);
    if (!isRevoked(this.client.connection)) await this.client.asyncCall("watchClose", [this.id]);
  }
}
