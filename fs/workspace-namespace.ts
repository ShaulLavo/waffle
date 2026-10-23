import type { MemoryBackend } from "./backend.js";
import type { DirNode, Node } from "./memory.js";
import type { FileIdentity, FileId } from "./file-identity.js";
import { FilesystemError, type FileStat } from "../core/filesystem.js";
import { normalize } from "../core/path.js";
import { namespaceCut, type NamespacePage, type NamespaceRecord } from "./workspace-protocol.js";
import { WORKSPACE_LIMITS, type SnapshotOptions } from "./workspace-types.js";
import type { PublicationCut } from "./publication.js";

interface Frame {
  readonly node: DirNode;
  readonly name: string;
  readonly iterator: MapIterator<[string, Node]>;
}
interface Scan {
  readonly cut: PublicationCut;
  readonly frames: Frame[];
  readonly prefix: string | null;
  readonly includeDirs: boolean;
  rootPending: boolean;
  pending?: { node: Node; parent: DirNode | null; name: string };
}
interface Metadata {
  readonly stat: FileStat;
  readonly identity: FileIdentity;
}
class ScanPressure extends Error {
  constructor(readonly resource: "depth" | "path" | "page") {
    super(resource);
  }
}
/** Authority-local iterators over the actual namespace. No lock survives a pull. */
export class NamespaceAuthority {
  private readonly cursors = new Map<number, Scan>();
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
      this.cursors.delete(id);
      return;
    }
    this.stopped = true;
    this.cursors.clear();
  }
  next(id: number, options: SnapshotOptions): NamespacePage {
    const domain = this.backend.shared.publication!;
    if (
      this.stopped ||
      domain.stopped ||
      this.backend.fs.root !== this.root ||
      domain.buffers.history !== this.history
    ) {
      this.close();
      return { kind: "stopped" };
    }
    let scan = this.cursors.get(id);
    if (!scan && id <= this.serial) return { kind: "cancelled" };
    if (!scan && this.cursors.size >= WORKSPACE_LIMITS.cursors) {
      this.serial = id;
      return { kind: "pressure", resource: "cursor" };
    }
    try {
      const metadata = this.metadata();
      if (!scan) scan = this.start(id, options, metadata);
      const current = domain.cut();
      if (current.history !== scan.cut.history || current.generation !== scan.cut.generation) {
        this.close(id);
        return { kind: "restart", current: namespaceCut(this.backend.workspaceId, current) };
      }
      const page = this.pull(scan, metadata);
      if (page.kind !== "entries") this.close(id);
      return page;
    } catch (error) {
      this.close(id);
      if (error instanceof ScanPressure) return { kind: "pressure", resource: error.resource };
      throw error;
    }
  }
  private metadata(): Map<number, Metadata> {
    const result = new Map<number, Metadata>();
    for (const handle of this.backend.shared.registeredHandles()) {
      const stat = this.backend.shared.stat(handle),
        identity = this.backend.shared.identity(handle);
      if (stat && identity) result.set(stat.ino, { stat, identity });
    }
    return result;
  }
  private start(id: number, options: SnapshotOptions, metadata: Map<number, Metadata>): Scan {
    this.serial = id;
    const prefix = options.prefix ?? "/";
    const scan: Scan = {
      cut: this.backend.shared.publication!.cut(),
      frames: [],
      rootPending: true,
      prefix: this.resolvePrefix(prefix, metadata) ? normalize(prefix) : null,
      includeDirs: options.includeDirs ?? true,
    };
    this.cursors.set(id, scan);
    return scan;
  }
  private resolvePrefix(path: string, metadata: Map<number, Metadata>): boolean {
    if (!path.startsWith("/") || path.includes("\0")) throw new FilesystemError(28);
    if (path.length > WORKSPACE_LIMITS.pathUnits) throw new ScanPressure("path");
    let node: Node = this.root;
    const parents: DirNode[] = [];
    for (const part of path.split("/")) {
      if (!part) continue;
      if (node.kind !== "dir") throw new FilesystemError(54);
      this.require(node, metadata, 1);
      if (part === ".") continue;
      if (part === "..") {
        node = parents.pop() ?? this.root;
        continue;
      }
      const child = node.children.get(part);
      if (!child) return false;
      if (parents.length >= WORKSPACE_LIMITS.depth) throw new ScanPressure("depth");
      parents.push(node);
      node = child;
    }
    if (path.endsWith("/") && node.kind !== "dir") throw new FilesystemError(54);
    return true;
  }
  private require(node: Node, metadata: Map<number, Metadata>, access: number): void {
    const mode = metadata.get(node.ino)?.stat.mode ?? node.mode;
    if (((mode >>> 6) & access) !== access) throw new FilesystemError(2);
  }
  private pull(scan: Scan, metadata: Map<number, Metadata>): NamespacePage {
    if (!scan.rootPending && !scan.frames.length)
      return { kind: "complete", cut: namespaceCut(this.backend.workspaceId, scan.cut) };
    const entries: NamespaceRecord[] = [];
    let charge = 0,
      visited = 0;
    while (
      entries.length < WORKSPACE_LIMITS.pageEntries &&
      visited < WORKSPACE_LIMITS.visitedEdges
    ) {
      const next = this.take(scan);
      if (!next) break;
      visited++;
      const path = this.path(scan, next.name);
      const item = this.entry(next.node, next.parent, next.name, path, metadata);
      const bytes = 192 + 2 * (path.length + next.name.length);
      if (bytes > WORKSPACE_LIMITS.pageBytes) throw new ScanPressure("page");
      if (charge + bytes > WORKSPACE_LIMITS.pageBytes) {
        scan.pending = next;
        break;
      }
      charge += bytes;
      entries.push({ ...item, selected: this.selected(scan, item) });
      if (next.node.kind === "dir") this.descend(scan, next.node, next.name, metadata);
    }
    return { kind: "entries", entries };
  }
  private selected(scan: Scan, entry: NamespaceRecord): boolean {
    if (scan.prefix === null || (!scan.includeDirs && entry.kind === "directory")) return false;
    return (
      scan.prefix === "/" || entry.path === scan.prefix || entry.path.startsWith(`${scan.prefix}/`)
    );
  }
  private take(scan: Scan): { node: Node; parent: DirNode | null; name: string } | undefined {
    if (scan.pending) {
      const pending = scan.pending;
      scan.pending = undefined;
      return pending;
    }
    if (scan.rootPending) {
      scan.rootPending = false;
      return { node: this.root, parent: null, name: "" };
    }
    while (scan.frames.length) {
      const frame = scan.frames.at(-1)!;
      const item = frame.iterator.next();
      if (item.done) {
        scan.frames.pop();
        continue;
      }
      return { node: item.value[1], parent: frame.node, name: item.value[0] };
    }
  }
  private path(scan: Scan, name: string): string {
    const parts = scan.frames
      .slice(1)
      .map((frame) => frame.name)
      .concat(name ? [name] : []);
    const length = parts.length ? parts.reduce((sum, part) => sum + part.length + 1, 0) : 1;
    if (length > WORKSPACE_LIMITS.pathUnits) throw new ScanPressure("path");
    return `/${parts.join("/")}`;
  }
  private descend(scan: Scan, node: DirNode, name: string, metadata: Map<number, Metadata>): void {
    this.require(node, metadata, 5);
    if (scan.frames.length >= WORKSPACE_LIMITS.depth) throw new ScanPressure("depth");
    scan.frames.push({ node, name, iterator: node.children.entries() });
  }
  private entry(
    node: Node,
    parent: DirNode | null,
    name: string,
    path: string,
    metadata: Map<number, Metadata>,
  ): NamespaceRecord {
    const resident = metadata.get(node.ino),
      identity = resident?.identity ?? this.backend.ensureIdentity(node);
    const parentId: FileId | null = parent
      ? (metadata.get(parent.ino)?.identity ?? this.backend.ensureIdentity(parent)).id
      : null;
    return {
      ...identity,
      parent: parentId,
      name,
      path,
      selected: false,
      kind: node.kind === "dir" ? "directory" : "file",
      size: resident?.stat.size ?? (node.kind === "file" ? (node.size ?? node.data.length) : 0),
      mtime: resident?.stat.mtime ?? node.mtime,
      mode: resident?.stat.mode ?? node.mode,
    };
  }
}
