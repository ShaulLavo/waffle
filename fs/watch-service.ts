import { FilesystemError } from "../core/filesystem.js";
import type { MemoryBackend } from "./backend.js";
import type { Node } from "./memory.js";
import { WATCH_CAPACITY, validWatchName, type WatchRecord } from "./watch-ring.js";
import type { WatchBatch, WatchEvent } from "./watch.js";

const MAX_NODES = 4096;
const MAX_EDGES = 16384;
const MAX_WATCHES = 128;
const MAX_PATH_UNITS = 4096;
interface WatchNode {
  readonly directory: boolean;
  mode: number;
  readonly parents: Map<bigint, Set<string>>;
}
interface Subscription {
  readonly owner: number;
  readonly root: bigint;
  readonly recursive: boolean;
  events: WatchEvent[];
  overflow: boolean;
}

/** One metadata graph per filesystem, shared by overlapping subscriptions. */
export class WatchService {
  private readonly nodes = new Map<bigint, WatchNode>();
  private readonly subscriptions = new Map<number, Subscription>();
  private cursor = 0;
  private serial = 0;
  private edges = 0;
  private incomplete = false;
  constructor(private readonly backend: MemoryBackend) {}
  open(owner: number, handle: number, recursive: boolean, cancelled: () => boolean): number {
    return this.backend.shared.mutate(undefined, cancelled, () =>
      this.registerWatch(owner, handle, recursive, cancelled),
    );
  }
  private registerWatch(
    owner: number,
    handle: number,
    recursive: boolean,
    cancelled: () => boolean,
  ): number {
    try {
      if (cancelled()) throw new FilesystemError(11);
      const id = this.openLocked(owner, handle, recursive);
      if (!cancelled()) return id;
      this.close(owner, id);
      throw new FilesystemError(11);
    } finally {
      if (!this.subscriptions.size) this.nodes.clear();
    }
  }
  private openLocked(owner: number, handle: number, recursive: boolean): number {
    if (this.subscriptions.size >= MAX_WATCHES)
      throw new FilesystemError(6, "watch capacity exhausted");
    if (!this.subscriptions.size) this.capture();
    this.drain();
    if (this.incomplete)
      throw new FilesystemError(6, "watch graph overflow; close watches before registering again");
    const node = this.backend.fs.nodeForHandle(handle);
    const root = this.backend.ensureIdentity(node).id;
    const metadata = this.nodes.get(root);
    if (!metadata) throw new FilesystemError(44);
    this.access(metadata);
    if (this.serial === Number.MAX_SAFE_INTEGER)
      throw new FilesystemError(6, "watch identifiers exhausted");
    const id = ++this.serial;
    this.subscriptions.set(id, { owner, root, recursive, events: [], overflow: false });
    this.backend.shared.watch.retain();
    return id;
  }
  private capture(): void {
    this.nodes.clear();
    this.edges = 0;
    this.incomplete = false;
    const pending = [this.backend.fs.root];
    while (pending.length) this.captureNode(pending.pop()!, pending);
    this.cursor = this.backend.shared.watch.sequence;
    if (this.cursor === Number.MAX_SAFE_INTEGER)
      throw new FilesystemError(6, "watch sequence exhausted");
  }
  private captureNode(node: Node, pending: Node[]): void {
    const id = this.backend.ensureIdentity(node).id;
    this.captureMetadata(node);
    if (node.kind !== "dir") return;
    for (const [name, child] of node.children) {
      if (!validWatchName(name)) throw new FilesystemError(6, "watch name bound exceeded");
      if (++this.edges > MAX_EDGES) throw new FilesystemError(6, "watch edge bound exceeded");
      this.captureMetadata(child);
      this.addParent(this.backend.ensureIdentity(child).id, id, name);
      if (child.kind === "dir") pending.push(child);
    }
  }
  private captureMetadata(node: Node): WatchNode {
    const id = this.backend.ensureIdentity(node).id;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    if (this.nodes.size >= MAX_NODES) throw new FilesystemError(6, "watch node bound exceeded");
    const handle = this.backend.fs.existingHandle(node);
    const mode =
      handle === undefined ? node.mode : (this.backend.shared.stat(handle)?.mode ?? node.mode);
    const metadata = {
      directory: node.kind === "dir",
      mode,
      parents: new Map<bigint, Set<string>>(),
    };
    this.nodes.set(id, metadata);
    return metadata;
  }
  private addParent(file: bigint, parent: bigint, name: string): void {
    const node = this.nodes.get(file);
    if (!node) return;
    let names = node.parents.get(parent);
    if (!names) node.parents.set(parent, (names = new Set()));
    names.add(name);
  }
  private access(node: WatchNode): void {
    const required = node.directory ? 0o500 : 0o400;
    if ((node.mode & required) !== required) throw new FilesystemError(2);
  }
  read(owner: number, id: number): WatchBatch {
    return this.backend.shared.mutate(undefined, undefined, () => {
      const watch = this.owned(owner, id);
      this.drain();
      if (watch.overflow) return { kind: "overflow", events: [] };
      const node = this.nodes.get(watch.root);
      if (node) this.access(node);
      const events = watch.events;
      watch.events = [];
      return { kind: "events", events };
    });
  }
  close(owner: number, id: number): void {
    if (!this.subscriptions.has(id)) return;
    this.owned(owner, id);
    this.subscriptions.delete(id);
    this.backend.shared.watch.release();
    if (!this.subscriptions.size) this.nodes.clear();
  }
  closeOwner(owner: number): void {
    for (const [id, watch] of this.subscriptions) if (watch.owner === owner) this.close(owner, id);
  }
  private owned(owner: number, id: number): Subscription {
    const watch = this.subscriptions.get(id);
    if (!watch || watch.owner !== owner) throw new FilesystemError(8);
    return watch;
  }
  private overflow(): void {
    this.incomplete = true;
    for (const watch of this.subscriptions.values()) {
      watch.overflow = true;
      watch.events = [];
    }
  }
  private drain(): void {
    if (this.incomplete) return;
    const records = this.backend.shared.watch.read(this.cursor);
    if (!records) return this.overflow();
    this.cursor = this.backend.shared.watch.sequence;
    for (const record of records) {
      this.accept(record);
      if (this.incomplete) return;
    }
  }
  private accept(record: WatchRecord): void {
    if (record.kind === "overflow") return this.overflow();
    if (record.kind === "inode") {
      if (this.nodes.size >= MAX_NODES) return this.overflow();
      this.nodes.set(record.file, {
        directory: record.directory,
        mode: record.mode,
        parents: new Map(),
      });
      return;
    }
    if (record.kind === "entry") return this.entry(record);
    if (record.kind === "metadata") {
      const node = this.nodes.get(record.file);
      if (node) node.mode = record.mode;
    }
    this.deliver(record.file, "change");
  }
  private entry(record: Extract<WatchRecord, { kind: "entry" }>): void {
    this.deliver(record.parent, "rename", record.name, record.after || record.before);
    this.deliverTarget(record.before);
    if (record.after !== record.before) this.deliverTarget(record.after);
    if (record.before) {
      const names = this.nodes.get(record.before)?.parents.get(record.parent);
      if (names?.delete(record.name)) this.edges--;
    }
    if (!record.after) return;
    if (++this.edges > MAX_EDGES) return this.overflow();
    this.addParent(record.after, record.parent, record.name);
  }
  private deliverTarget(file: bigint): void {
    if (!file) return;
    for (const watch of this.subscriptions.values()) {
      if (watch.root === file) this.enqueue(watch, { type: "rename", id: file, name: null });
    }
  }
  private deliver(file: bigint, type: WatchEvent["type"], suffix?: string, changed = file): void {
    for (const watch of this.subscriptions.values())
      this.deliverWatch(watch, file, type, suffix, changed);
  }
  private deliverWatch(
    watch: Subscription,
    file: bigint,
    type: WatchEvent["type"],
    suffix: string | undefined,
    changed: bigint,
  ): void {
    if (watch.overflow) return;
    const names = this.names(file, watch);
    if (!names) return this.overflow();
    for (const name of names) {
      const path = suffix === undefined ? name : name ? `${name}/${suffix}` : suffix;
      if (path && path.length > MAX_PATH_UNITS) return this.overflow();
      if (!watch.recursive && path?.includes("/")) continue;
      this.enqueue(watch, { type, id: changed, name: path || null });
    }
  }
  private names(file: bigint, watch: Subscription): (string | null)[] | undefined {
    const result: (string | null)[] = [];
    const pending = [{ file, path: "" }];
    let steps = 0;
    while (pending.length) {
      if (++steps > MAX_EDGES || result.length > WATCH_CAPACITY) return;
      const current = pending.pop()!;
      if (current.path.length > MAX_PATH_UNITS) return;
      if (current.file === watch.root) result.push(current.path || null);
      else this.ancestors(current, pending);
    }
    return result;
  }
  private ancestors(
    current: { file: bigint; path: string },
    pending: { file: bigint; path: string }[],
  ): void {
    const node = this.nodes.get(current.file);
    if (!node) return;
    for (const [parent, names] of node.parents)
      this.parentPaths(parent, names, current.path, pending);
  }
  private parentPaths(
    parent: bigint,
    names: Set<string>,
    path: string,
    pending: { file: bigint; path: string }[],
  ): void {
    if (((this.nodes.get(parent)?.mode ?? 0) & 0o500) !== 0o500) return;
    for (const name of names) pending.push({ file: parent, path: path ? `${name}/${path}` : name });
  }
  private enqueue(watch: Subscription, event: WatchEvent): void {
    if (
      watch.overflow ||
      watch.events.some(
        (old) => old.type === event.type && old.id === event.id && old.name === event.name,
      )
    )
      return;
    if (watch.events.length >= WATCH_CAPACITY) {
      watch.overflow = true;
      watch.events = [];
      return;
    }
    watch.events.push(event);
  }
}
