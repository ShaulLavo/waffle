import { FilesystemError } from "../core/filesystem.js";
import type { LocalMutationPlan, MemoryBackend } from "./backend.js";
import { captureWatchIndex, indexWatchNode } from "./watch-capture.js";
import { WatchIndex } from "./watch-index.js";
import { WatchRouting } from "./watch-routing.js";
import { WatchSubscriptions, type HeldWatchBatch } from "./watch-subscriptions.js";
import { WATCH_CAPACITY, type WatchRecord } from "./watch-ring.js";
import type { WatchBatch, WatchEvent } from "./watch.js";

/** One live metadata index and pooled event allocator per backend root. */
export class WatchService {
  private readonly index: WatchIndex;
  private readonly subscriptions: WatchSubscriptions;
  private cursor = 0;
  private incomplete = false;
  private directories = 0;
  constructor(private readonly backend: MemoryBackend) {
    this.index = new WatchIndex(backend.watchAccount);
    this.subscriptions = new WatchSubscriptions(backend.watchAccount, this.index);
    backend.installWatchObserver(this);
  }
  resources() {
    return {
      ...this.index.resources(),
      ...this.subscriptions.resources(),
      incomplete: this.incomplete,
    };
  }
  open(owner: number, handle: number, recursive: boolean, cancelled: () => boolean): number {
    return this.backend.shared.mutate(undefined, cancelled, () =>
      this.register(owner, handle, recursive, cancelled),
    );
  }
  private register(
    owner: number,
    handle: number,
    recursive: boolean,
    cancelled: () => boolean,
  ): number {
    try {
      if (cancelled()) throw new FilesystemError(11);
      const node = this.backend.fs.nodeForHandle(handle);
      if (!this.backend.fs.hasNode(node)) throw new FilesystemError(44);
      if (!this.subscriptions.size) {
        this.incomplete = false;
        captureWatchIndex(this.backend, this.index, cancelled);
        this.cursor = this.backend.shared.watch.sequence;
      }
      this.drain();
      if (cancelled()) throw new FilesystemError(11);
      if (this.incomplete || this.cursor === Number.MAX_SAFE_INTEGER)
        throw new FilesystemError(6, "watch metadata incomplete");
      const root = this.backend.ensureIdentity(node).id;
      if (cancelled()) throw new FilesystemError(11);
      this.access(root);
      const id = this.subscriptions.open(owner, root, recursive);
      if (this.index.metadata(root).directory) this.directories++;
      this.backend.shared.watch.retain();
      if (!cancelled()) return id;
      this.close(owner, id);
      throw new FilesystemError(11);
    } catch (error) {
      if (cancelled()) throw new FilesystemError(11);
      throw error;
    } finally {
      if (!this.subscriptions.size) this.index.clear();
    }
  }
  private access(id: bigint): void {
    const metadata = this.index.metadata(id);
    const required = metadata.directory ? 0o500 : 0o400;
    if ((metadata.mode & required) !== required) throw new FilesystemError(2);
  }
  readHeld(owner: number, id: number): HeldWatchBatch {
    return this.backend.shared.mutate(undefined, undefined, () => {
      const root = this.subscriptions.root(owner, id);
      this.drain();
      if (!this.incomplete && !this.subscriptions.overflowed(owner, id)) this.access(root);
      return this.subscriptions.batch(owner, id);
    });
  }
  read(owner: number, id: number): WatchBatch {
    const held = this.readHeld(owner, id);
    try {
      return held.batch;
    } finally {
      held.release();
    }
  }
  close(owner: number, id: number): void {
    let directory = false;
    try {
      directory = this.index.metadata(this.subscriptions.root(owner, id)).directory;
    } catch (error) {
      if (!(error instanceof FilesystemError) || error.errno !== 8) throw error;
    }
    if (!this.subscriptions.close(owner, id)) return;
    if (directory) this.directories--;
    this.backend.shared.watch.release();
    if (!this.subscriptions.size) this.index.clear();
  }
  closeOwner(owner: number): void {
    const count = this.subscriptions.closeOwner(owner);
    for (let at = 0; at < count; at++) this.backend.shared.watch.release();
    if (!this.subscriptions.size) {
      this.index.clear();
      this.directories = 0;
      return;
    }
    this.directories = 0;
    this.subscriptions.forEach((peer, id) => {
      if (this.index.metadata(this.subscriptions.root(peer, id)).directory) this.directories++;
    });
  }
  private overflow(): void {
    this.incomplete = true;
    this.subscriptions.forEach((owner, id) => this.subscriptions.overflow(owner, id));
  }
  private drain(): void {
    if (this.incomplete || !this.subscriptions.size) return;
    const sequence = this.backend.shared.watch.sequence;
    if (sequence === this.cursor && sequence !== Number.MAX_SAFE_INTEGER) return;
    let control: { release(): void } | undefined;
    try {
      control = this.backend.watchAccount.reserveControl(WATCH_CAPACITY * (2048 + 64));
      const records = this.backend.shared.watch.read(this.cursor);
      if (!records) return this.overflow();
      this.cursor = sequence;
      for (const record of records) this.accept(record);
    } catch {
      this.overflow();
    } finally {
      control?.release();
    }
  }

  beforeMutation(): void {
    this.drain();
  }
  committed(plan: LocalMutationPlan): void {
    if (!this.subscriptions.size) return;
    try {
      if (!this.incomplete) this.applyPlan(plan);
    } catch {
      this.overflow();
    }
    this.backend.shared.watch.effects(plan.changes);
    this.cursor = this.backend.shared.watch.sequence;
    if (this.cursor === Number.MAX_SAFE_INTEGER) this.overflow();
  }
  private applyPlan(plan: LocalMutationPlan): void {
    this.restoreEntries(plan);
    for (const effect of plan.changes) this.effect(effect);
    this.collectEntries(plan);
  }
  private namespace(plan: LocalMutationPlan) {
    const action = plan.action;
    return action.kind === "namespace"
      ? action.plan
      : action.kind === "writeFile"
        ? action.namespace.plan
        : undefined;
  }
  private restoreEntries(plan: LocalMutationPlan): void {
    for (const edge of this.namespace(plan)?.edges ?? []) {
      const parent = this.backend.ensureIdentity(edge.parent).id;
      if (!this.index.has(parent)) indexWatchNode(this.backend, this.index, edge.parent);
      if (edge.after && !this.index.has(this.backend.ensureIdentity(edge.after).id))
        indexWatchNode(this.backend, this.index, edge.after);
    }
  }
  private collectEntries(plan: LocalMutationPlan): void {
    for (const edge of this.namespace(plan)?.edges ?? [])
      if (edge.before) this.index.collect(this.backend.ensureIdentity(edge.before).id);
  }
  private effect(effect: LocalMutationPlan["changes"][number]): void {
    if (effect.kind === "inode")
      return this.accept({
        kind: "inode",
        file: effect.file.id,
        mode: effect.mode,
        directory: effect.nodeKind === "directory",
      });
    if (effect.kind === "entry")
      return this.accept({
        kind: "entry",
        parent: effect.parent.id,
        before: effect.before?.id ?? 0n,
        after: effect.after?.id ?? 0n,
        name: effect.name,
      });
    if (effect.kind === "metadata")
      return this.accept({ kind: "metadata", file: effect.file.id, mode: effect.mode });
    this.accept({ kind: "change", file: effect.file.id });
  }
  private accept(record: WatchRecord): void {
    if (this.incomplete) return;
    if (record.kind === "overflow") return this.overflow();
    if (record.kind === "inode") {
      this.index.upsert(record.file, record.mode, record.directory);
      return;
    }
    if (record.kind === "entry") {
      this.deliver(record.parent, "rename", record.name, record.after || record.before);
      this.target(record.before, "rename");
      if (record.after !== record.before) this.target(record.after, "rename");
      if (record.before) this.index.unlink(record.parent, record.name);
      if (record.after) this.index.link(record.parent, record.after, record.name);
      return;
    }
    if (!this.index.has(record.file)) return;
    if (record.kind === "metadata")
      this.index.upsert(record.file, record.mode, this.index.metadata(record.file).directory);
    this.deliver(record.file, "change");
  }
  private target(file: bigint, type: WatchEvent["type"]): void {
    if (!file || !this.index.has(file)) return;
    this.subscriptions.forRoot(file, (owner, id) =>
      this.subscriptions.enqueue(owner, id, { type, id: file, name: null }),
    );
  }
  private deliver(file: bigint, type: WatchEvent["type"], suffix?: string, changed = file): void {
    if (!this.index.has(file)) return;
    if (suffix === undefined) this.target(file, type);
    if (!this.directories) return;
    const routes = new WatchRouting(this.backend.watchAccount);
    try {
      routes.push(file, "");
      for (let current = routes.pop(); current; current = routes.pop()) {
        this.deliverRoute(routes, current, type, suffix, changed);
      }
    } finally {
      routes.close();
    }
  }
  private deliverRoute(
    routes: WatchRouting,
    current: { id: bigint; path: string },
    type: WatchEvent["type"],
    suffix: string | undefined,
    changed: bigint,
  ): void {
    const path =
      suffix === undefined ? current.path : current.path ? `${current.path}/${suffix}` : suffix;
    if (path.length > 4096) throw new FilesystemError(6, "watch path bound exceeded");
    this.route(current.id, path, type, changed, suffix !== undefined || !!current.path);
    this.ancestors(routes, current.id, current.path);
  }
  private ancestors(routes: WatchRouting, id: bigint, path: string): void {
    this.index.forEachParent(id, (parent, name) => {
      if ((this.index.metadata(parent).mode & 0o500) !== 0o500) return;
      routes.push(parent, path ? `${name}/${path}` : name);
    });
  }
  private route(
    root: bigint,
    path: string,
    type: WatchEvent["type"],
    changed: bigint,
    report: boolean,
  ): void {
    if (!report) return;
    this.subscriptions.forRoot(root, (owner, id) => {
      if (!this.index.metadata(root).directory) return;
      if (!this.subscriptions.recursive(owner, id) && path.includes("/")) return;
      this.subscriptions.enqueue(owner, id, { type, id: changed, name: path || null });
    });
  }
}
