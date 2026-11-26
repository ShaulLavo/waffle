import { restoreTree } from "./persisted-tree.js";
import { ColdReadCache } from "./cold-read-cache.js";
import { utf8ByteLength } from "./utf8-size.js";
import type { ReadBacking } from "./workspace-read.js";
import type { MemoryBudget } from "./memory-budget.js";
import { DirtyCapacityError, type DirtyLimits } from "./dirty-admission.js";
import { restoreIdentity, storeIdentity, type IdentityReservation } from "./file-identity.js";
import {
  CheckpointPressure,
  type CheckpointLimits,
  type CheckpointCost,
} from "./checkpoint-pressure.js";
import { FilesystemError, PAGE } from "./protocol.js";
import type { FileHandle, FileStat } from "../core/index.js";
import { MemoryBackend, type LocalMutationPlan, type MemoryBackendSharedRoot } from "./backend.js";
import {
  MemFS,
  adoptInodes,
  type DirNode,
  type Node,
  type FileNode,
  type NamespacePlan,
} from "./memory.js";
import {
  storeTime,
  validatePersistedIndex,
  type PersistedIndex,
  type PersistedNode,
  type PersistenceBatch,
  type StorageBackend,
  type ReaderMetadataBudget,
} from "./storage.js";

interface CheckpointCaptureCost extends CheckpointCost {
  metadataBytes: number;
  readonly publicationMetadataLimit: number;
}

interface CheckpointRequest {
  readonly durable: boolean;
  readonly target: FileHandle | string | undefined;
  readonly selected: Node | undefined;
}
interface CheckpointCapture {
  readonly changed: Set<Node>;
  readonly data: Map<string, Uint8Array>;
  readonly detachedSnapshots: Map<FileNode, { handle: FileHandle; key: string; revision: number }>;
}

interface CheckpointEpoch {
  failure?: { cause: unknown };
}

/** A file's shared slot owns its times while it runs; checkpoints copy them to the tree. */
function copyTimes(node: Node, stat: FileStat): void {
  node.atime = stat.atime;
  node.mtime = stat.mtime;
  node.ctime = stat.ctime;
}

/** Memory is authoritative while running. Storage receives immutable, ordered checkpoints;
 * no lock or guest request is held across a background commit. */
export class PersistentBackend extends MemoryBackend {
  private readonly pressure: CheckpointPressure;
  private nodes = new Map<number, Node>();
  private byFileId = new Map<bigint, Node>();
  private dirEntryBytes = new WeakMap<DirNode, number>();
  private namespaceBytes = 0;
  private idleChangeSequence: number | undefined;
  private readonly initialWorkspaceId: string;
  private readonly initialEra: bigint;
  private readonly loadedIndex: boolean;
  private detached = new WeakSet<Node>();
  private links = new Map<number, number>();
  private removed = new Set<number>();
  private dirty = new Set<Node>();
  private keys = new Map<number, string>();
  private committedKeys = new Map<number, string>();
  private detachedKeys = new Map<number, string>();
  private revisions = new Map<number, number>();
  private registeredNodes = new Map<number, Node>();
  private loading = new Map<FileHandle, Promise<void>>();
  private lastCommit: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private sequence = 0;
  private checkpointEpoch: CheckpointEpoch = {};
  private pendingCheckpoints = 0;
  private admittedWork = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private nonce = crypto.randomUUID();
  private renewing?: Promise<void>;
  private readonly coldReads = new ColdReadCache();
  private constructor(
    private storage: StorageBackend,
    fs: MemFS,
    reservation: IdentityReservation,
    index?: PersistedIndex,
    intervalMs = 50,
    checkpointLimits?: Partial<CheckpointLimits>,
    private readonly dirtyLimits: Partial<DirtyLimits> | false = {},
    startupRoot?: MemoryBudget,
    sharedRoot?: MemoryBackendSharedRoot,
  ) {
    super(fs, reservation, startupRoot, undefined, sharedRoot);
    this.initialWorkspaceId = reservation.workspace;
    this.initialEra = reservation.era;
    this.loadedIndex = index !== undefined;
    this.pressure = new CheckpointPressure(checkpointLimits);
    const visit = (node: Node) => {
      this.links.set(node.ino, (this.links.get(node.ino) ?? 0) + 1);
      if (this.nodes.has(node.ino)) return;
      this.nodes.set(node.ino, node);
      this.namespaceBytes += this.nodeMetadataBytes(node);
      if (node.identity) this.byFileId.set(node.identity.id, node);
      if (node.kind === "dir") for (const child of node.children.values()) visit(child);
    };
    visit(fs.root);
    this.configureDirty();
    if (index) {
      this.generation = index.generation;
      for (const node of index.nodes) {
        if (node.data) this.keys.set(node.ino, node.data);
        if (node.mode === undefined) this.dirty.add(this.nodes.get(node.ino)!);
      }
      this.committedKeys = new Map(this.keys);
    } else this.dirty.add(fs.root);
    fs.onDirEntryDelta = (dir, delta) => {
      const existing = this.dirEntryBytes.get(dir);
      if (existing !== undefined) this.dirEntryBytes.set(dir, existing + delta);
      if (this.nodes.has(dir.ino)) this.namespaceBytes += delta;
    };
    fs.onLinkChange = (node, delta) => this.changeLinks(node, delta);
    fs.onChange = (node) => {
      if (!this.detached.has(node)) {
        this.nodes.set(node.ino, node);
        if (node.identity) this.byFileId.set(node.identity.id, node);
        this.dirty.add(node);
      }
    };
    this.startTimer(intervalMs);
  }
  get initialReservationEra(): bigint {
    return this.initialEra;
  }
  get hasLoadedIndex(): boolean {
    return this.loadedIndex;
  }
  /**
   * Whether the storage still belongs to this connection's epoch. IndexedDB may answer from an
   * epoch read made by one of its own open commits (see IndexedDBStorage.verifyEpoch). That is
   * sound only because the caller, the multitab lease renewal, confirms it still holds the
   * storage Web Lock first: keep the lock query before this call.
   */
  async verifyStorageEpoch(signal?: AbortSignal): Promise<boolean> {
    if ("verifyEpoch" in this.storage && typeof this.storage.verifyEpoch === "function") {
      return (this.storage as { verifyEpoch(s?: AbortSignal): Promise<boolean> }).verifyEpoch(
        signal,
      );
    }
    return true;
  }
  nodeByFileId(fileId: bigint): Node | undefined {
    const node = this.byFileId.get(fileId);
    if (node && node.identity?.id === fileId) return node;
    return undefined;
  }
  resolveNodePublic(path: string): Node | undefined {
    return this.resolveNode(path);
  }
  ensureLoadedHandle(handle: FileHandle): void | Promise<void> {
    return this.ensureLoaded(handle);
  }
  isTerminallyFailed(): boolean {
    return this.storage.isTerminallyFailed?.() ?? false;
  }
  terminalFailureReason(): unknown {
    return this.storage.terminalFailureReason?.();
  }
  setTerminalFailureListener(listener: (reason: unknown) => void): void {
    this.storage.setTerminalFailureListener?.(listener);
  }
  private hasPendingChanges(): boolean {
    if (this.dirty.size > 0 || this.removed.size > 0 || this.shared.publication) return true;
    return (
      this.idleChangeSequence === undefined ||
      this.shared.changeSequence !== this.idleChangeSequence
    );
  }
  private startTimer(intervalMs: number): void {
    if (intervalMs > 0)
      this.timer = setInterval(() => {
        if (!this.stopped && !this.pendingCheckpoints && this.hasPendingChanges())
          void this.checkpoint().catch(() => {});
      }, intervalMs);
  }
  static async open(
    storage: StorageBackend,
    options: {
      intervalMs?: number;
      checkpointLimits?: Partial<CheckpointLimits>;
      dirtyLimits?: Partial<DirtyLimits> | false;
      startupRoot?: MemoryBudget;
      sharedRoot?: MemoryBackendSharedRoot;
      signal?: AbortSignal;
    } = {},
  ): Promise<PersistentBackend> {
    options.signal?.throwIfAborted();
    const index = await storage.load();
    options.signal?.throwIfAborted();
    if (index) validatePersistedIndex(index);
    const reservation = await storage.reserveIdentity(index?.nodes[0]?.identity?.workspace);
    options.signal?.throwIfAborted();
    validateReservation(index, reservation);
    if (!index)
      return new PersistentBackend(
        storage,
        new MemFS(),
        reservation,
        undefined,
        options.intervalMs,
        options.checkpointLimits,
        options.dirtyLimits,
        options.startupRoot,
        options.sharedRoot,
      );
    const fs = restoreTree(index);
    const root = fs.root;
    adoptInodes(root);
    const backend = new PersistentBackend(
      storage,
      fs,
      reservation,
      index,
      0,
      options.checkpointLimits,
      options.dirtyLimits,
      options.startupRoot,
      options.sharedRoot,
    );
    try {
      if (!index.nodes[0]?.identity) {
        await storage.flush();
        options.signal?.throwIfAborted();
        for (const node of backend.nodes.values()) backend.dirty.add(node);
        await backend.flush(undefined, options.signal);
      }
      options.signal?.throwIfAborted();
      backend.startTimer(options.intervalMs ?? 50);
      return backend;
    } catch (error) {
      backend.dispose();
      throw error;
    }
  }
  private changeLinks(node: Node, delta: 1 | -1): void {
    const previous = this.links.get(node.ino) ?? 0;
    const count = previous + delta;
    if (count > 0) this.links.set(node.ino, count);
    else this.links.delete(node.ino);
    if (delta === 1 && previous === 0) {
      this.nodes.set(node.ino, node);
      this.namespaceBytes += this.nodeMetadataBytes(node);
      if (node.identity) this.byFileId.set(node.identity.id, node);
      this.detached.delete(node);
      const key = this.detachedKeys.get(node.ino);
      if (key) {
        // The namespace entry is new, but this payload is already durable. Restore its
        // rollback baseline too, so a failed reattachment checkpoint can retry cold.
        this.keys.set(node.ino, key);
        this.committedKeys.set(node.ino, key);
        this.detachedKeys.delete(node.ino);
      }
      this.removed.delete(node.ino);
      if (node.kind === "file") this.revisions.delete(this.fs.handleForNode(node));
      this.dirty.add(node);
      if (node.kind === "dir")
        for (const child of node.children.values()) this.changeLinks(child, 1);
    } else if (delta === -1 && count === 0) {
      this.nodes.delete(node.ino);
      this.namespaceBytes -= this.nodeMetadataBytes(node);
      this.dirty.delete(node);
      this.detached.add(node);
      this.removed.add(node.ino);
      if (node.kind === "dir")
        for (const child of node.children.values()) this.changeLinks(child, -1);
    }
  }
  protected identityChanged(node: Node): void {
    if (node.identity) this.byFileId.set(node.identity.id, node);
    if (this.isLinked(node)) this.dirty.add(node);
  }
  protected isLinked(node: Node): boolean {
    return this.nodes.has(node.ino);
  }
  private resolveNode(path: string): Node | undefined {
    let node: Node | undefined = this.fs.lookup(path);
    if (!node && path.startsWith("/")) {
      const resolved = this.fs.resolveAbsolute(path, true);
      if (typeof resolved !== "number" && resolved.node !== undefined)
        node = this.fs.nodeForHandle(resolved.node);
    }
    return node;
  }
  /** Dead handles are no longer enumerable in shared memory; prune their private owners too. */
  private pruneDetached(): void {
    for (const [handle, node] of this.registeredNodes)
      if (this.shared.revision(handle) === undefined) {
        this.registeredNodes.delete(handle);
        this.revisions.delete(handle);
        if (this.detached.has(node)) {
          this.keys.delete(node.ino);
          this.detachedKeys.delete(node.ino);
        }
      }
  }
  private retainedData(): string[] {
    const keys: string[] = [];
    for (const [handle, node] of this.registeredNodes)
      if (this.detached.has(node) && this.shared.revision(handle) !== undefined) {
        const key = this.committedKeys.get(node.ino) ?? this.detachedKeys.get(node.ino);
        if (key) keys.push(key);
      }
    return keys;
  }
  protected sync(handle: FileHandle): void {
    const node = this.fs.nodeForHandle(handle);
    this.registeredNodes.set(handle, node);
    if (node.kind !== "file") {
      super.sync(handle);
      return;
    }
    const registered = this.shared.hasFile(handle);
    const loaded = node.size === undefined;
    this.shared.register(
      handle,
      this.fs.stat(handle),
      node.data,
      loaded,
      this.ensureIdentity(node),
    );
    if (!registered && loaded) {
      // The page pool owns the only mutable payload. Retaining initial MemFS buffers doubles
      // workspace memory and, after direct writes, would retain an obsolete second copy.
      node.size = node.data.length;
      node.data = new Uint8Array();
    }
    if (!registered && !loaded) {
      const revision = this.shared.revision(handle);
      if (revision !== undefined) this.revisions.set(handle, revision);
    }
  }
  override selectReadBacking(
    node: FileNode,
    offset: number,
    length: number,
    full = false,
    metadata?: ReaderMetadataBudget,
    cancelled?: () => boolean,
  ): ReadBacking {
    this.assertAdmitting();
    const handle = this.fs.handleForNode(node);
    if (!length || this.shared.isResident(handle) || node.size === undefined)
      return super.selectReadBacking(node, offset, length, full);
    return this.coldBacking(node, this.coldKey(node, handle, cancelled), metadata, cancelled);
  }
  /** The stored payload key of a clean cold file, which names exactly its current bytes. */
  private coldKey(node: FileNode, handle: FileHandle, cancelled?: () => boolean): string {
    const key = this.detachedKeys.get(node.ino) ?? this.committedKeys.get(node.ino);
    if (
      !key ||
      (this.shared.hasFile(handle) &&
        this.shared.revision(handle, false, cancelled) !== this.revisions.get(handle))
    )
      throw new FilesystemError(6, "cold revision is not retained");
    return key;
  }
  private coldBacking(
    node: FileNode,
    key: string,
    metadata?: ReaderMetadataBudget,
    cancelled?: () => boolean,
  ): Extract<ReadBacking, { kind: "cold" }> {
    const size = this.readMetadata(node, cancelled).size;
    const retention = this.storage.retainPayload(key, size, metadata);
    return { kind: "cold", key, size, storage: this.storage, retention };
  }
  prepareDescriptorRead(
    handle: FileHandle,
    offset: number,
    length: number,
    cancelled: () => boolean,
  ): Promise<Uint8Array> | undefined {
    this.assertAdmitting();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
      throw new FilesystemError(28);
    if (cancelled()) throw new FilesystemError(11);
    if (!(this.fs.permissions(handle).access & 4)) throw new FilesystemError(2);
    const node = this.fs.nodeForHandle(handle);
    if (node.kind !== "file") throw new FilesystemError(31);
    this.sync(handle);
    if (this.shared.isResident(handle)) return;
    const size = this.readMetadata(node, cancelled).size;
    const count = Math.min(length, PAGE, Math.max(0, size - offset));
    if (!count) return Promise.resolve(new Uint8Array());
    if (node.size === undefined) throw new FilesystemError(6);
    // Resident files returned above. A clean cold file's key fixes its bytes, so cached pages
    // need no storage read or payload retention, only storage that could still serve them.
    const key = this.coldKey(node, handle, cancelled);
    const cached = this.coldReads.read(key, offset, count);
    if (cached) {
      this.storage.checkPayload(key, size);
      this.coldReads.noteRead(key, offset + count);
      return this.cachedDescriptorRange(cached, cancelled);
    }
    // A sequential scan fetches a page-aligned readahead window in one storage read; its pages
    // are verified with it and serve the next requests from the cache.
    const window = this.coldReads.readWindow(key, offset, count, size);
    const backing = this.coldBacking(node, key, undefined, cancelled);
    this.coldReads.noteRead(key, offset + count);
    const drained = Promise.withResolvers<void>();
    this.ownWork(drained.promise);
    const range = this.readDescriptorRange(backing, window.offset, window.length, cancelled);
    const reply =
      window.offset === offset && window.length === count
        ? range
        : range.then((bytes) =>
            bytes.slice(offset - window.offset, offset - window.offset + count),
          );
    return reply.finally(() => {
      const release = Promise.resolve().then(() => backing.retention.release());
      void release.then(drained.resolve, drained.reject);
      return release;
    });
  }
  private async readDescriptorRange(
    backing: Extract<ReadBacking, { kind: "cold" }>,
    offset: number,
    length: number,
    cancelled: () => boolean,
  ): Promise<Uint8Array> {
    if (cancelled() || this.stopped) throw new FilesystemError(11);
    const bytes = await backing.storage.readRange(backing.key, { offset, length });
    if (cancelled() || this.stopped) throw new FilesystemError(11);
    if (bytes.length !== length) throw new Error("Short retained descriptor range");
    this.coldReads.store(backing.key, offset, bytes, backing.size);
    return bytes;
  }
  private async cachedDescriptorRange(
    bytes: Uint8Array,
    cancelled: () => boolean,
  ): Promise<Uint8Array> {
    if (cancelled() || this.stopped) throw new FilesystemError(11);
    return bytes;
  }
  private evictClean(except?: FileHandle): void {
    // Registration is bounded independently of workspace size. Idle metadata and clean payload
    // slots may be reclaimed; held capabilities keep their identity and dirty bytes stay resident.
    for (const handle of this.shared.registeredHandles()) {
      if (handle === except || this.loading.has(handle)) continue;
      const revision = this.shared.revision(handle);
      const stat = this.shared.stat(handle);
      if (!stat || revision === undefined) continue;
      const node = this.registeredNodes.get(handle);
      if (!node) continue;
      if (node.kind !== "file") {
        if (this.shared.evict(handle, revision)) this.registeredNodes.delete(handle);
        continue;
      }
      if (this.revisions.get(handle) !== revision) continue;
      if (
        this.shared.isResident(handle) &&
        this.keys.get(node.ino) !== this.committedKeys.get(node.ino)
      )
        continue;
      node.identity = this.shared.identity(handle) ?? node.identity;
      node.size = stat.size;
      copyTimes(node, stat);
      if (this.shared.evict(handle, revision)) {
        this.revisions.delete(handle);
        this.registeredNodes.delete(handle);
      } else this.shared.unload(handle, revision);
    }
  }
  private ensureLoaded(handle: FileHandle): void | Promise<void> {
    const node = this.fs.nodeForHandle(handle);
    if (node.kind !== "file") return;
    this.sync(handle);
    if (this.shared.isResident(handle)) return;
    const pending = this.loading.get(handle);
    if (pending) return pending;
    const key = this.detachedKeys.get(node.ino) ?? this.keys.get(node.ino);
    const revision = this.shared.revision(handle);
    const shared = this.shared,
      publication = shared.publication;
    // The asynchronous preparation owns a pin independently of the requesting capability.
    // A namespace replacement, cancellation or trim may otherwise reclaim its slot mid-read.
    this.retain(handle);
    const load = Promise.resolve()
      .then(async () => {
        if (this.stopped || publication?.stopped || this.shared !== shared) return;
        const data = key ? await this.storage.read(key) : new Uint8Array();
        // A complete overwrite/truncate may have made this disk read obsolete. Never install
        // an old payload over newer shared bytes or metadata, even for the same inode.
        if (
          this.stopped ||
          publication?.stopped ||
          this.shared !== shared ||
          this.shared.publication !== publication ||
          this.registeredNodes.get(handle) !== node ||
          this.shared.revision(handle) !== revision ||
          this.shared.isResident(handle)
        )
          return;
        if (data.length !== node.size)
          throw new Error(`persisted filesystem payload size mismatch for inode ${node.ino}`);
        const resources = this.shared.resources();
        if (resources.usedBytes + data.length > resources.maxBytes) this.evictClean(handle);
        // Registration already records the clean revision. Hydration preserves it; sampling
        // after hydrate unlocks could misclassify another guest's immediate write as clean.
        this.shared.hydrate(handle, data);
      })
      .finally(() => {
        this.loading.delete(handle);
        this.release(handle);
      });
    this.loading.set(handle, load);
    return this.ownWork(load);
  }
  private namespaceUnits(): number {
    return this.namespaceBytes * 4;
  }
  private configureDirty(): void {
    if (this.dirtyLimits === false) return;
    this.shared.dirtyAdmission.configure(
      this.dirtyLimits,
      this.pressure.limits,
      this.namespaceUnits(),
    );
  }
  override attachShared(...args: Parameters<MemoryBackend["attachShared"]>): void {
    const previous = this.shared;
    super.attachShared(...args);
    if (previous !== this.shared) {
      this.idleChangeSequence = undefined;
      this.configureDirty();
    }
  }
  private namespaceGrowth(plan: NamespacePlan): number {
    let units = plan.created.reduce((sum, node) => sum + this.nodeMetadataBytes(node), 0);
    for (const edge of plan.edges) if (edge.after) units += 64 + edge.name.length * 2;
    for (const parent of plan.parents)
      if (!this.dirty.has(parent)) units += this.nodeMetadataBytes(parent);
    return units * 4;
  }
  protected override admitMutation(plan: LocalMutationPlan): void {
    if (!this.shared.dirtyAdmission.enabled || !plan.changes.length) return;
    const action = plan.action;
    const namespace = action.kind === "writeFile" ? action.namespace : action;
    const files = new Map<FileHandle, number>();
    let units = 0;
    if (namespace.kind === "namespace") {
      units = this.namespaceGrowth(namespace.plan);
      for (const handle of namespace.registered) files.set(handle, 0);
      for (const parent of namespace.plan.parents) {
        const handle = this.fs.handleForNode(parent);
        this.sync(handle);
        files.set(handle, 0);
      }
    }
    if (action.kind === "write" || action.kind === "writeFile") {
      const size =
        action.kind === "writeFile" && !action.append
          ? action.data.length
          : Math.max(this.shared.info(action.handle)!.size, action.offset + action.data.length);
      files.set(action.handle, size);
    }
    if (action.kind === "resize")
      files.set(
        action.handle,
        action.truncate
          ? action.size
          : Math.max(this.shared.info(action.handle)!.size, action.size),
      );
    if (action.kind === "setMode" || action.kind === "setTimes") {
      const node = this.fs.nodeForHandle(action.handle);
      if (node.kind === "dir" && !this.dirty.has(node)) units += this.nodeMetadataBytes(node) * 4;
      files.set(action.handle, this.shared.stat(action.handle)!.size);
    }
    this.shared.prepareDirtyMutation(files, units);
  }
  override execute(
    operation: string,
    args: Parameters<MemoryBackend["execute"]>[1],
    data: Uint8Array,
  ): unknown {
    this.assertAdmitting();
    if (operation === "dirtyWait") return;
    return super.execute(operation, args, data);
  }
  dirtyPressure() {
    return this.shared.dirtyAdmission.diagnostics(this.shared.resources().usedBytes);
  }
  async waitForDirtyCapacity(changed: number, cancelled: () => boolean): Promise<void> {
    this.assertAdmitting();
    this.evictClean();
    const admission = this.shared.dirtyAdmission;
    if (admission.change !== changed) return;
    const pending = this.pressure.diagnostics().pendingOperations > 0;
    if (!pending && !admission.hasDebt) throw new DirtyCapacityError(true);
    let failure: unknown;
    const wait = admission.wait(
      changed,
      () => cancelled() || this.stopped || !!this.closing,
      () => failure,
    );
    const progress = pending ? this.lastCommit : this.checkpoint(true);
    void progress.catch((error) => {
      failure = error;
    });
    return wait;
  }
  renewIdentityReservation(): Promise<void> {
    this.assertAdmitting();
    if (this.renewing) return this.renewing;
    const work = this.storage.reserveIdentity(this.workspaceId).then((reservation) => {
      this.assertOpen();
      this.shared.mutate(undefined, undefined, () => this.shared.identities.configure(reservation));
    });
    this.renewing = this.ownWork(work).finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }
  prepare(operation: string, args: any[]): void | Promise<void> {
    this.assertAdmitting();
    if (this.shared.identities.available < 8192n)
      return this.renewIdentityReservation().then(() => this.prepareOperation(operation, args));
    return this.prepareOperation(operation, args);
  }
  private prepareOperation(operation: string, args: any[]): void | Promise<void> {
    this.assertAdmitting();
    const target = ["read", "write", "append", "grow", "resize"].includes(operation)
      ? args[0]
      : operation === "readFile" || operation === "writeFile"
        ? this.resolveNode(args[0])
        : undefined;
    const handle =
      typeof target === "number"
        ? target
        : target?.kind === "file"
          ? this.fs.handleForNode(target)
          : undefined;
    if (handle !== undefined && operation !== "writeFile") {
      const access = operation === "read" || operation === "readFile" ? 4 : 2;
      if ((this.fs.permissions(handle).access & access) !== access) throw new FilesystemError(2);
    }
    if (handle !== undefined && operation === "writeFile" && !args[2]) {
      if (!(this.fs.permissions(handle).access & 2)) throw new FilesystemError(2);
    }
    const resources = this.shared.resources();
    if (resources.files > 1024 || resources.usedBytes >= resources.maxBytes / 2)
      this.evictClean(handle);
    if (["read", "write", "append", "grow", "resize"].includes(operation)) {
      if (operation === "resize" && args[1] === 0 && args[2]) this.sync(args[0]);
      else return this.ensureLoaded(args[0]);
    }
    if (operation === "remove") return this.prepareRemove(args);
    if (operation === "readFile" || operation === "writeFile") {
      const node = this.resolveNode(args[0]);
      if (node?.kind === "file") {
        const handle = this.fs.handleForNode(node);
        if (operation === "writeFile") {
          // Exclusive creation only needs the namespace entry. Avoid hydrating or registering
          // an existing cold payload before execute can return EEXIST.
          if (args[2]) return;
          if (!args[1]) this.sync(handle);
          else return this.ensureLoaded(handle);
        } else return this.ensureLoaded(handle);
      }
    }
  }
  /** A conditional remove compares the current bytes, so load a cold payload first. */
  private prepareRemove(args: readonly unknown[]): void | Promise<void> {
    if (args[1] !== true || typeof args[0] !== "string") return;
    const node = this.resolveNode(args[0]);
    if (node?.kind === "file") return this.ensureLoaded(this.fs.handleForNode(node));
  }
  /** Capture only dirty nodes and changed resident payloads. Cost is bounded by the shared
   * slot table plus changes, not by the number of cold files in a workspace. */
  flush(target?: FileHandle | string, signal?: AbortSignal): Promise<void> {
    return this.checkpoint(true, target, signal);
  }
  private assertAdmitting(): void {
    if (this.closing) throw new Error("filesystem persistence backend is closed");
    this.assertOpen();
  }
  private ownWork(work: Promise<void>): Promise<void> {
    this.admittedWork.add(work);
    void work.then(
      () => this.admittedWork.delete(work),
      () => this.admittedWork.delete(work),
    );
    return work;
  }
  private assertOpen(): void {
    if (this.stopped) throw new Error("filesystem persistence backend is closed");
  }
  private async flushOpen(keys?: readonly string[]): Promise<void> {
    this.assertOpen();
    await this.storage.flush(keys);
    this.assertOpen();
  }
  checkpointPressure() {
    return this.pressure.diagnostics();
  }
  /** Cancellation ends observation, not ownership of an already captured checkpoint. */
  checkpoint(durable = false, target?: FileHandle | string, signal?: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(new Error("filesystem persistence backend is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    let work: Promise<void>;
    try {
      work = this.ownWork(this.captureCheckpoint(durable, target));
    } catch (error) {
      return Promise.reject(error);
    }
    if (!signal) return work;
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private cachedDirEntryBytes(node: DirNode): number {
    let entryBytes = this.dirEntryBytes.get(node);
    if (entryBytes !== undefined) return entryBytes;
    entryBytes = 0;
    for (const name of node.children.keys()) entryBytes += 64 + name.length * 2;
    this.dirEntryBytes.set(node, entryBytes);
    return entryBytes;
  }
  private nodeMetadataBytes(node: Node): number {
    if (node.kind === "symlink") return 256 + node.target.length * 2 + utf8ByteLength(node.target);
    if (node.kind === "dir") return 256 + this.cachedDirEntryBytes(node);
    return 256;
  }
  private pinMetadataBytes(): number {
    let bytes = 0;
    for (const [handle, node] of this.registeredNodes) {
      if (this.shared.revision(handle) === undefined) continue;
      const key = this.committedKeys.get(node.ino) ?? this.detachedKeys.get(node.ino);
      if (key) bytes += 128 + key.length * 2;
    }
    return bytes;
  }
  private captureCost({ durable, target, selected }: CheckpointRequest): CheckpointCaptureCost {
    let bytes = 0;
    let metadataBytes = 256 + this.removed.size * 256;
    for (const node of this.dirty) metadataBytes += this.nodeMetadataBytes(node);
    for (const handle of this.shared.registeredHandles()) {
      const revision = this.shared.revision(handle);
      if (revision === undefined || revision === this.revisions.get(handle)) continue;
      const node = this.registeredNodes.get(handle);
      if (node?.kind !== "file") continue;
      if (this.detached.has(node) && (!durable || (target !== undefined && selected !== node)))
        continue;
      if (!this.dirty.has(node)) metadataBytes += this.nodeMetadataBytes(node);
      if (this.shared.isResident(handle)) bytes += (this.shared.stat(handle)?.size ?? 0) * 2;
    }
    metadataBytes += this.pinMetadataBytes();
    // Retention uses the configured ceiling, never transient room behind queued captures.
    const publicationMetadataLimit = Math.max(
      0,
      Math.floor(this.pressure.limits.maxMetadataBytes / 4) - metadataBytes,
    );
    metadataBytes +=
      this.shared.publication?.checkpointMetadataBytes(publicationMetadataLimit) ?? 0;
    // Metadata units cover capture containers, adapter cloning and runtime pin lists.
    return { bytes, metadataBytes: metadataBytes * 4, publicationMetadataLimit };
  }
  private captureCheckpoint(durable = false, target?: FileHandle | string): Promise<void> {
    this.assertOpen();
    // Reserve and copy in one synchronous mutation section. No storage wait holds this lock.
    return this.shared.mutate(undefined, undefined, () => {
      const selected =
        typeof target === "string"
          ? this.resolveNode(target)
          : target === undefined
            ? undefined
            : this.fs.nodeForHandle(target);
      return this.reserveCheckpoint({ durable, target, selected });
    });
  }
  private includesDetachedWriters({ durable, target, selected }: CheckpointRequest): boolean {
    for (const [handle, node] of this.registeredNodes) {
      if (node.kind !== "file" || !this.detached.has(node)) continue;
      const revision = this.shared.revision(handle);
      if (revision === undefined || revision === this.revisions.get(handle)) continue;
      if (!durable || (target !== undefined && selected !== node)) return false;
    }
    return true;
  }
  private invalidateCapturedState(): void {
    this.idleChangeSequence = undefined;
    this.keys = new Map(this.committedKeys);
    // Cold baselines still identify retained durable bytes. Only resident captures need retry.
    for (const handle of this.revisions.keys())
      if (this.shared.isResident(handle)) this.revisions.delete(handle);
  }
  private reconcileDirtyAfterCommit(revision: number): void {
    if (!this.shared.dirtyAdmission.enabled || this.pendingCheckpoints > 0) return;
    const namespace = this.namespaceUnits();
    if (
      this.shared.dirtyAdmission.revision === revision &&
      !this.dirty.size &&
      !this.removed.size
    ) {
      this.shared.reconcileDirty(this.registeredNodes.keys(), namespace, 0, () => false);
      return;
    }
    let dirtyNamespace = this.removed.size * 256;
    for (const node of this.dirty) dirtyNamespace += this.nodeMetadataBytes(node);
    this.shared.reconcileDirty(
      this.registeredNodes.keys(),
      namespace,
      dirtyNamespace * 4,
      (handle, kind, currentRevision, dirtyMark) => {
        if (kind === 1) return currentRevision !== this.revisions.get(handle);
        if (dirtyMark !== 1) return false;
        const node = this.registeredNodes.get(handle);
        return node !== undefined && this.dirty.has(node);
      },
    );
  }
  private reserveCheckpoint(request: CheckpointRequest): Promise<void> {
    const cost = { ...this.captureCost(request) };
    this.shared.dirtyAdmission.reserveCopy(cost, this.shared.resources().usedBytes);
    let reservation: number;
    try {
      reservation = this.pressure.reserve(cost);
    } catch (error) {
      this.shared.dirtyAdmission.releaseCopy(cost);
      throw error;
    }
    const revision = this.includesDetachedWriters(request)
      ? this.shared.dirtyAdmission.revision
      : undefined;
    const capturedChangeSeq = this.shared.changeSequence;
    try {
      return this.captureReserved(request, reservation, cost)
        .then(() => {
          if (this.stopped) return;
          this.shared.mutate(undefined, undefined, () => {
            if (
              !this.pendingCheckpoints &&
              !this.dirty.size &&
              !this.removed.size &&
              this.shared.changeSequence === capturedChangeSeq
            )
              this.idleChangeSequence = capturedChangeSeq;
            if (revision !== undefined) this.reconcileDirtyAfterCommit(revision);
          });
        })
        .finally(() => {
          this.pressure.release(reservation);
          this.shared.mutate(undefined, undefined, () =>
            this.shared.dirtyAdmission.releaseCopy(cost),
          );
        });
    } catch (error) {
      this.pressure.release(reservation);
      this.shared.dirtyAdmission.releaseCopy(cost);
      this.invalidateCapturedState();
      throw error;
    }
  }
  private captureFile(
    handle: FileHandle,
    { durable, target, selected }: CheckpointRequest,
    { changed, data, detachedSnapshots }: CheckpointCapture,
  ): void {
    const revision = this.shared.revision(handle);
    if (revision === undefined || revision === this.revisions.get(handle)) return;
    const node = this.registeredNodes.get(handle);
    if (node?.kind !== "file") return;
    if (this.detached.has(node)) {
      if (!durable || (target !== undefined && selected !== node)) return;
      const snapshot = this.shared.snapshot(handle);
      if (!snapshot) return;
      const key = `${this.nonce}:${node.ino}:${++this.sequence}`;
      data.set(key, snapshot.data);
      detachedSnapshots.set(node, { handle, key, revision });
      // A detached fd owns bytes, not a name. A later relink must recapture its dirty revision.
      return;
    }
    const stat = this.shared.stat(handle);
    if (!stat) return;
    node.size = stat.size;
    copyTimes(node, stat);
    node.identity = this.shared.identity(handle) ?? node.identity;
    const snapshot = this.shared.snapshot(handle);
    if (snapshot) {
      const key = `${this.nonce}:${node.ino}:${++this.sequence}`;
      data.set(key, snapshot.data);
      this.keys.set(node.ino, key);
    }
    this.revisions.set(handle, revision);
    changed.add(node);
  }
  private persistedNode(node: Node): PersistedNode {
    const metadata = {
      ino: node.ino,
      identity: storeIdentity(this.ensureIdentity(node), this.workspaceId),
      atime: storeTime(node.atime),
      mtime: storeTime(node.mtime),
      ctime: storeTime(node.ctime),
      mode: node.mode,
    };
    if (node.kind === "dir")
      return {
        ...metadata,
        kind: "dir",
        size: 0,
        children: Array.from(node.children, ([name, child]) => [name, child.ino]),
      };
    if (node.kind === "socket") return { ...metadata, kind: "socket", size: 0 };
    if (node.kind === "symlink")
      return {
        ...metadata,
        kind: "symlink",
        size: utf8ByteLength(node.target),
        target: node.target,
      };
    return {
      ...metadata,
      kind: "file",
      size: node.size ?? node.data.length,
      data: this.keys.get(node.ino),
    };
  }
  private captureReserved(
    request: CheckpointRequest,
    reservation: number,
    cost: CheckpointCaptureCost,
  ): Promise<void> {
    const metadataBytes = cost.metadataBytes;
    const start = (metadata: number) => {
      this.pressure.start(reservation, metadata);
      const growth = Math.max(0, metadata - cost.metadataBytes);
      this.shared.mutate(undefined, undefined, () =>
        this.shared.dirtyAdmission.growCopyMetadata(growth),
      );
      cost.metadataBytes += growth;
    };
    const { durable, target, selected } = request;
    const publication = this.shared.publication?.checkpoint(cost.publicationMetadataLimit);
    this.pruneDetached();
    const capture: CheckpointCapture = {
      changed: new Set(this.dirty),
      data: new Map(),
      detachedSnapshots: new Map(),
    };
    for (const handle of this.shared.registeredHandles())
      this.captureFile(handle, request, capture);
    const { changed, data, detachedSnapshots } = capture;
    const upserts: PersistedNode[] = Array.from(changed, (node) => this.persistedNode(node));
    this.dirty.clear();
    const removes = Array.from(this.removed);
    this.removed.clear();
    const key =
      selected?.kind === "file"
        ? (detachedSnapshots.get(selected)?.key ??
          this.keys.get(selected.ino) ??
          this.detachedKeys.get(selected.ino))
        : undefined;
    const flushKeys = target === undefined ? undefined : key ? [key] : [];
    if (!publication && !upserts.length && !removes.length && !data.size)
      return this.lastCommit.then(() => {
        this.assertOpen();
        start(metadataBytes);
        return durable ? this.flushOpen(flushKeys) : undefined;
      });
    const epoch = this.checkpointEpoch;
    const batch: PersistenceBatch = {
      ...(publication ? { publication } : {}),
      generation: 0,
      root: this.fs.root.ino,
      upserts,
      removes,
      data,
    };
    this.pendingCheckpoints++;
    const commit = this.tail
      .then(async () => {
        this.assertOpen();
        if (epoch.failure) throw epoch.failure.cause;
        start(metadataBytes + this.pinMetadataBytes() * 4);
        batch.generation = this.generation + 1;
        // A later request may have reattached an inode removed by this older checkpoint.
        // Its next upsert still needs the durable payload even though it is no longer detached.
        batch.retainedData = this.retainedData().concat(
          removes.flatMap((ino) => {
            const key = this.committedKeys.get(ino);
            return this.nodes.has(ino) && key ? [key] : [];
          }),
          Array.from(detachedSnapshots.values(), (snapshot) => snapshot.key),
        );
        await this.storage.persist(batch);
        this.assertOpen();
        this.generation = batch.generation;
        for (const entry of upserts) if (entry.data) this.committedKeys.set(entry.ino, entry.data);
        this.pruneDetached();
        const retained = new Set(this.retainedData());
        for (const ino of removes) {
          if (this.nodes.has(ino)) continue; // A later link still owns this durable baseline.
          const key = this.committedKeys.get(ino);
          if (key && retained.has(key)) this.detachedKeys.set(ino, key);
          this.committedKeys.delete(ino);
          this.keys.delete(ino);
        }
        for (const [node, snapshot] of detachedSnapshots) {
          // Last close or a relink may have happened while persist waited. Never recreate
          // a dead fd's pin or overwrite the baseline now owned by a linked checkpoint.
          if (
            this.detached.has(node) &&
            this.registeredNodes.get(snapshot.handle) === node &&
            this.shared.revision(snapshot.handle) !== undefined
          ) {
            this.detachedKeys.set(node.ino, snapshot.key);
            this.revisions.set(snapshot.handle, snapshot.revision);
          }
        }
      })
      .finally(() => {
        this.pendingCheckpoints--;
      });
    this.lastCommit = commit;
    this.tail = commit.catch((cause: unknown) => {
      if (this.stopped) return;
      this.checkpointEpoch.failure ??= { cause };
      this.checkpointEpoch = {};
      for (const node of changed) if (!this.detached.has(node)) this.dirty.add(node);
      // A later request may have linked an open inode back into the namespace while
      // this commit waited. Retry the current tree, not the failed checkpoint's removals.
      for (const ino of removes) if (!this.nodes.has(ino)) this.removed.add(ino);
      this.invalidateCapturedState();
    });
    return commit.then(() => {
      this.assertOpen();
      return durable ? this.flushOpen(flushKeys) : undefined;
    });
  }
  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private stopPersistence(): void {
    this.stopped = true;
    this.cancelTimer();
    this.coldReads.clear();
  }
  dispose(): void {
    if (this.closing) return;
    this.stopPersistence();
  }
  private async finishClose(work: readonly Promise<void>[]): Promise<void> {
    try {
      const outcomes = await Promise.allSettled(work);
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
      await this.captureCheckpoint(true);
      this.stopPersistence();
      await this.storage.close();
      this.watchAccount.close();
    } finally {
      // A failed close keeps `closing`, so nothing reads the cache again; free it either way.
      this.coldReads.clear();
    }
  }
  /** Retire persistence without attempting a final checkpoint, joining all admitted work and
   * closing storage + watch account cleanly before any shared-memory remount reset. */
  async retireFenced(options: { throwOnStorageCloseError?: boolean } = {}): Promise<void> {
    this.stopPersistence();
    const work = Array.from(
      new Set(Array.from(this.admittedWork).concat([this.lastCommit, this.tail])),
    );
    await Promise.allSettled(work);
    this.coldReads.clear();
    let closeFailure: { failed: true; reason: unknown } | undefined;
    try {
      await this.storage.close();
    } catch (reason) {
      if (options.throwOnStorageCloseError) closeFailure = { failed: true, reason };
    }
    this.watchAccount.close();
    if (closeFailure) throw closeFailure.reason;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const owner = Promise.withResolvers<void>();
    this.closing = owner.promise;
    this.cancelTimer();
    const work = Array.from(
      new Set(Array.from(this.admittedWork).concat([this.lastCommit, this.tail])),
    );
    void this.finishClose(work).then(owner.resolve, owner.reject);
    return owner.promise;
  }
}

function validateReservation(
  index: PersistedIndex | undefined,
  reservation: IdentityReservation,
): void {
  for (const node of index?.nodes ?? []) {
    if (!node.identity) continue;
    const identity = restoreIdentity(node.identity);
    if (identity.id >> 64n >= reservation.era || identity.version >> 64n >= reservation.era)
      throw new Error("Filesystem identity exceeds durable reservation highwater");
  }
}
