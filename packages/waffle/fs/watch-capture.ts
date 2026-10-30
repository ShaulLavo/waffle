import { FilesystemError } from "../core/filesystem.js";
import type { MemoryBackend } from "./backend.js";
import type { Node } from "./memory.js";
import { WatchArena } from "./watch-arena.js";
import { watchId, setWatchId } from "./watch-id-index.js";
import { WatchIndex } from "./watch-index.js";

export function indexWatchNode(backend: MemoryBackend, index: WatchIndex, node: Node): bigint {
  const id = backend.ensureIdentity(node).id;
  const handle = backend.fs.existingHandle(node);
  const mode = handle === undefined ? node.mode : (backend.shared.stat(handle)?.mode ?? node.mode);
  index.upsert(id, mode, node.kind === "dir");
  return id;
}

class Capture {
  private readonly frames: WatchArena;
  private readonly pending: Iterator<[string, Node]>[] = [];
  private control: { release(): void } | undefined;
  private capacity = 0;
  constructor(
    private readonly backend: MemoryBackend,
    private readonly index: WatchIndex,
  ) {
    this.frames = new WatchArena(backend.watchAccount, "scratch");
  }
  private push(node: Extract<Node, { kind: "dir" }>, id: bigint): void {
    if (this.pending.length === this.capacity) this.grow();
    setWatchId(this.frames.view, this.pending.length * 16, id);
    this.pending.push(node.children.entries());
  }
  private grow(): void {
    const next = Math.max(1, this.capacity * 2);
    const charge = this.backend.watchAccount.reserveControl(next * 128);
    try {
      this.frames.stage(next * 16).commit();
    } catch (error) {
      charge.release();
      throw error;
    }
    this.control?.release();
    this.control = charge;
    this.capacity = next;
  }
  private step(cancelled: () => boolean): void {
    if (cancelled()) throw new FilesystemError(11);
    const next = this.pending[this.pending.length - 1]!.next();
    if (next.done) {
      this.pending.pop();
      return;
    }
    const child = next.value[1];
    const parent = watchId(this.frames.view, (this.pending.length - 1) * 16);
    const id = indexWatchNode(this.backend, this.index, child);
    this.index.link(parent, id, next.value[0]);
    if (child.kind === "dir") this.push(child, id);
  }
  capture(cancelled: () => boolean): void {
    try {
      const root = indexWatchNode(this.backend, this.index, this.backend.fs.root);
      this.index.setRoot(root);
      this.push(this.backend.fs.root, root);
      while (this.pending.length) this.step(cancelled);
    } catch (error) {
      this.index.clear();
      throw error;
    } finally {
      this.frames.close();
      this.control?.release();
    }
  }
}
export function captureWatchIndex(
  backend: MemoryBackend,
  index: WatchIndex,
  cancelled: () => boolean,
): void {
  new Capture(backend, index).capture(cancelled);
}
