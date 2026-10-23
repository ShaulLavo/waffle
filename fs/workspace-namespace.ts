import type { MemoryBackend } from "./backend.js";
import type { DirNode, Node } from "./memory.js";
import { NamespaceCursor } from "./namespace-cursor.js";
import { namespaceCut, type NamespacePage, type NamespaceRecord } from "./workspace-protocol.js";
import { WORKSPACE_LIMITS, type NamespaceCut, type SnapshotOptions } from "./workspace-types.js";

/** Authority-local iterators over the actual namespace. No lock survives a pull. */
export class NamespaceAuthority {
  private readonly cursors = new Map<number, NamespaceCursor>();
  private serial = 0;
  private stopped = false;
  private readonly root: DirNode;
  private readonly history: string;
  constructor(private readonly backend: MemoryBackend) {
    this.root = backend.fs.root;
    this.history = backend.shared.publication!.buffers.history;
  }
  get size(): number {
    return this.cursors.size;
  }
  close(id?: number): void {
    if (id !== undefined) {
      this.serial = Math.max(this.serial, id);
      this.cursors.get(id)?.close();
      this.cursors.delete(id);
      return;
    }
    this.stopped = true;
    for (const cursor of this.cursors.values()) cursor.close();
    this.cursors.clear();
  }
  next(id: number, options: SnapshotOptions): NamespacePage {
    if (!this.current()) {
      this.close();
      return { kind: "stopped" };
    }
    let cursor = this.cursors.get(id);
    if (!cursor && id <= this.serial) return { kind: "cancelled" };
    if (!cursor && this.cursors.size >= WORKSPACE_LIMITS.cursors) {
      this.serial = id;
      return { kind: "pressure", resource: "cursor" };
    }
    try {
      if (!cursor) {
        this.serial = id;
        cursor = new NamespaceCursor(
          {
            root: this.root,
            metadata: (node) => this.metadata(node),
            current: () => this.current(),
          },
          options,
        );
        this.cursors.set(id, cursor);
      }
      const page = cursor.next();
      if (page.kind !== "entries") this.close(id);
      return page;
    } catch (error) {
      this.close(id);
      throw error;
    }
  }
  private current(): NamespaceCut | undefined {
    const domain = this.backend.shared.publication!;
    if (
      this.stopped ||
      domain.stopped ||
      this.backend.fs.root !== this.root ||
      domain.buffers.history !== this.history
    )
      return;
    return namespaceCut(this.backend.workspaceId, domain.cut());
  }
  private metadata(
    node: Node,
  ): Pick<NamespaceRecord, "id" | "version" | "size" | "mode" | "mtime"> {
    const handle = this.backend.fs.existingHandle(node);
    const stat = handle === undefined ? undefined : this.backend.shared.stat(handle);
    const identity = handle === undefined ? undefined : this.backend.shared.identity(handle);
    if (stat && identity)
      return {
        ...identity,
        size: stat.size,
        mode: stat.mode ?? node.mode,
        mtime: stat.mtime,
      };
    return {
      ...this.backend.ensureIdentity(node),
      size: node.kind === "file" ? (node.size ?? node.data.length) : 0,
      mode: node.mode,
      mtime: node.mtime,
    };
  }
}
