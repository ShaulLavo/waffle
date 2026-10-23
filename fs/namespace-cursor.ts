import { FilesystemError } from "../core/filesystem.js";
import { normalize } from "../core/path.js";
import type { DirNode, Node } from "./memory.js";
import type { NamespacePage, NamespaceRecord } from "./workspace-protocol.js";
import { WORKSPACE_LIMITS, type NamespaceCut, type SnapshotOptions } from "./workspace-types.js";

type Metadata = Pick<NamespaceRecord, "id" | "version" | "size" | "mode" | "mtime">;
export interface NamespaceSource {
  readonly root: DirNode;
  /** Resolve just this node without registering cold files or collecting namespace metadata. */
  metadata(node: Node): Metadata;
  current(): NamespaceCut | undefined;
}
type Limit = "pageEntries" | "pageBytes" | "visitedEdges" | "depth" | "pathUnits";
type Limits = Readonly<Record<Limit, number>>;
type Terminal = Exclude<NamespacePage, { kind: "entries" }>;
interface Frame {
  readonly iterator: MapIterator<[string, Node]>;
  readonly id: Metadata["id"];
  readonly parentPathUnits: number;
}
interface Position {
  readonly node: Node;
  readonly parent: Metadata["id"] | null;
  readonly name: string;
}
interface Scan {
  readonly source: NamespaceSource;
  readonly cut: NamespaceCut;
  readonly frames: Frame[];
  readonly includeDirs: boolean;
  prefix: string | null;
  initialized: boolean;
  rootPending: boolean;
  pending: Position | undefined;
  path: string;
}
class CursorPressure extends Error {
  constructor(readonly resource: "depth" | "path" | "page") {
    super(resource);
  }
}
function limits(overrides: Partial<Limits>): Limits {
  const result: Limits = { ...WORKSPACE_LIMITS, ...overrides };
  const keys: readonly Limit[] = ["pageEntries", "pageBytes", "visitedEdges", "depth", "pathUnits"];
  for (const key of keys) {
    const value = result[key],
      maximum = WORKSPACE_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(key);
  }
  return result;
}
function sameCut(left: NamespaceCut, right: NamespaceCut): boolean {
  return (
    left.workspace === right.workspace &&
    left.generation === right.generation &&
    left.watermark.history === right.watermark.history &&
    left.watermark.seq === right.watermark.seq
  );
}
function requireAccess(mode: number, access: number): void {
  if (((mode >>> 6) & access) !== access) throw new FilesystemError(2);
}

export class NamespaceCursor {
  private state: { kind: "scanning"; scan: Scan } | { kind: "terminal"; page: Terminal };
  private readonly bounds: Limits;
  private signal: AbortSignal | undefined;
  private readonly abort = () => this.close();
  constructor(
    source: NamespaceSource,
    options: SnapshotOptions = {},
    signal?: AbortSignal,
    overrides: Partial<Limits> = {},
  ) {
    this.bounds = limits(overrides);
    const cut = signal?.aborted ? undefined : source.current();
    this.state = { kind: "terminal", page: { kind: signal?.aborted ? "cancelled" : "stopped" } };
    if (signal?.aborted || !cut) return;
    const prefix = options.prefix ?? "/";
    if (prefix.length > this.bounds.pathUnits) {
      this.state = { kind: "terminal", page: { kind: "pressure", resource: "path" } };
      return;
    }
    this.state = {
      kind: "scanning",
      scan: {
        source,
        cut,
        frames: [],
        prefix,
        includeDirs: options.includeDirs ?? true,
        initialized: false,
        rootPending: true,
        pending: undefined,
        path: "",
      },
    };
    this.signal = signal;
    signal?.addEventListener("abort", this.abort, { once: true });
  }
  resources(): { frames: number; pending: number; pathUnits: number } {
    if (this.state.kind === "terminal") return { frames: 0, pending: 0, pathUnits: 0 };
    const scan = this.state.scan;
    return {
      frames: scan.frames.length,
      pending: Number(scan.pending !== undefined),
      pathUnits: scan.path.length + (scan.prefix?.length ?? 0),
    };
  }
  close(): void {
    if (this.state.kind === "scanning") this.finish({ kind: "cancelled" });
  }
  next(): NamespacePage {
    if (this.state.kind === "terminal") return this.state.page;
    const scan = this.state.scan;
    try {
      const before = this.check(scan);
      if (before) return before;
      if (!scan.initialized) this.initialize(scan);
      const page = this.pull(scan);
      const after = this.check(scan);
      if (after) return after;
      return page.kind === "entries" ? page : this.finish(page);
    } catch (error) {
      const terminal = this.terminal();
      if (terminal) return terminal;
      if (error instanceof CursorPressure)
        return this.finish({ kind: "pressure", resource: error.resource });
      this.finish({ kind: "cancelled" });
      throw error;
    }
  }
  private check(scan: Scan): Terminal | undefined {
    if (this.state.kind === "terminal") return this.state.page;
    const current = scan.source.current();
    const terminal = this.terminal();
    if (terminal) return terminal;
    if (!current) return this.finish({ kind: "stopped" });
    if (!sameCut(scan.cut, current)) return this.finish({ kind: "restart", current });
  }
  private terminal(): Terminal | undefined {
    return this.state.kind === "terminal" ? this.state.page : undefined;
  }
  private finish(page: Terminal): Terminal {
    if (this.state.kind === "scanning") {
      this.state.scan.frames.length = 0;
      this.state.scan.pending = undefined;
      this.state.scan.path = "";
    }
    this.state = { kind: "terminal", page };
    this.signal?.removeEventListener("abort", this.abort);
    this.signal = undefined;
    return page;
  }
  private initialize(scan: Scan): void {
    const prefix = scan.prefix;
    if (prefix === null) return;
    if (!prefix.startsWith("/") || prefix.includes("\0")) throw new FilesystemError(28);
    scan.prefix = this.resolvePrefix(scan, prefix) ? normalize(prefix) : null;
    scan.initialized = true;
  }
  private resolvePrefix(scan: Scan, path: string): boolean {
    let node: Node = scan.source.root;
    const parents: DirNode[] = [];
    for (const part of path.split("/")) {
      if (!part) continue;
      if (node.kind !== "dir") throw new FilesystemError(54);
      const metadata = scan.source.metadata(node);
      if (this.terminal()) return false;
      requireAccess(metadata.mode, 1);
      if (part === ".") continue;
      if (part === "..") {
        node = parents.pop() ?? scan.source.root;
        continue;
      }
      const child = node.children.get(part);
      if (!child) return false;
      if (parents.length >= this.bounds.depth) throw new CursorPressure("depth");
      parents.push(node);
      node = child;
    }
    if (path.endsWith("/") && node.kind !== "dir") throw new FilesystemError(54);
    return true;
  }
  private pull(scan: Scan): NamespacePage {
    const entries: NamespaceRecord[] = [];
    let bytes = 0;
    for (
      let visited = 0;
      visited < this.bounds.visitedEdges && entries.length < this.bounds.pageEntries;
      visited++
    ) {
      const terminal = this.terminal();
      if (terminal) return terminal;
      const position = this.take(scan);
      if (!position && !scan.frames.length) break;
      if (!position) continue;
      const path = this.path(scan, position.name);
      const charge = 192 + 2 * (path.length + position.name.length);
      if (charge > this.bounds.pageBytes) throw new CursorPressure("page");
      if (bytes + charge > this.bounds.pageBytes) {
        scan.pending = position;
        break;
      }
      const metadata = scan.source.metadata(position.node);
      const cancelled = this.terminal();
      if (cancelled) return cancelled;
      if (position.node.kind === "dir") this.descend(scan, position.node, metadata, path);
      entries.push({
        ...metadata,
        parent: position.parent,
        name: position.name,
        path,
        kind: position.node.kind === "dir" ? "directory" : "file",
        selected: this.selected(scan, position.node, path),
      });
      bytes += charge;
    }
    if (!entries.length && !scan.rootPending && !scan.pending && !scan.frames.length)
      return { kind: "complete", cut: scan.cut };
    return { kind: "entries", entries };
  }
  private take(scan: Scan): Position | undefined {
    if (scan.pending) {
      const pending = scan.pending;
      scan.pending = undefined;
      return pending;
    }
    if (scan.rootPending) {
      scan.rootPending = false;
      return { node: scan.source.root, parent: null, name: "" };
    }
    const frame = scan.frames.at(-1);
    if (!frame) return;
    const item = frame.iterator.next();
    if (!item.done) return { node: item.value[1], parent: frame.id, name: item.value[0] };
    scan.frames.pop();
    scan.path = scan.path.slice(0, frame.parentPathUnits);
  }
  private path(scan: Scan, name: string): string {
    const length = name ? scan.path.length + 1 + name.length : 1;
    if (length > this.bounds.pathUnits) throw new CursorPressure("path");
    return name ? `${scan.path}/${name}` : "/";
  }
  private descend(scan: Scan, node: DirNode, metadata: Metadata, path: string): void {
    requireAccess(metadata.mode, 5);
    if (scan.frames.length >= this.bounds.depth) throw new CursorPressure("depth");
    scan.frames.push({
      iterator: node.children.entries(),
      id: metadata.id,
      parentPathUnits: scan.path.length,
    });
    scan.path = path === "/" ? "" : path;
  }
  private selected(scan: Scan, node: Node, path: string): boolean {
    if (scan.prefix === null || (!scan.includeDirs && node.kind === "dir")) return false;
    return scan.prefix === "/" || path === scan.prefix || path.startsWith(`${scan.prefix}/`);
  }
}
