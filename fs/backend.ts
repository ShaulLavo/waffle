import { truncateBoundaryEnd } from "./shared-version-pages.js";
import type { ReaderMetadataBudget } from "./storage.js";
import type { ReadBacking } from "./workspace-read.js";
import type { MemoryBudget } from "./memory-budget.js";
import {
  mapPublicationFiles,
  type FileKey,
  mutationIntent,
  mutationValue,
  type MutationIntent,
  type MutationResult,
  type PublicationEffect,
} from "./publication.js";
import { type FileIdentity, type IdentityReservation, IdentityAllocator } from "./file-identity.js";
import type { PublicationBuffers } from "./publication-internal.js";
import { type FileHandle, type ResolvedPath } from "../core/index.js";
import { MemFS, type Node, type NamespacePlan } from "./memory.js";
import { FilesystemError } from "./protocol.js";
import { SharedFilesystemState, type SharedSegment } from "./shared.js";

/** Storage boundary. 3b can add asynchronous loading/commit without changing guest transport. */
export interface FilesystemBackend {
  execute(operation: string, args: any[], data: Uint8Array): unknown | Promise<unknown>;
  retain(handle: FileHandle): void;
  release(handle: FileHandle): void;
  resources?(): Record<string, number>;
  revokeOwner?(owner: number, epoch?: Int32Array): void;
  takeSharedSegments?(): SharedSegment[];
  sharedSegments?(): SharedSegment[];
  /** Lazy storage reads finish before the service acquires its mutation lock. */
  prepare?(operation: string, args: any[], data: Uint8Array): void | Promise<void>;
  waitForDirtyCapacity?(changed: number, cancelled: () => boolean): Promise<void>;
  /** File identity/path limits explicit durability to that file; omitted flushes the workspace. */
  flush?(target?: FileHandle | string): Promise<void>;
  /** Release startup resources when cancellation races backend creation. */
  close?(): Promise<void>;
}
const namespaceOperations = new Set([
  "preopen",
  "create",
  "symlink",
  "link",
  "removePath",
  "rename",
  "writeFile",
  "mkdirp",
  "remove",
  "move",
]);
interface NamespaceAction {
  readonly kind: "namespace";
  readonly plan: NamespacePlan;
  readonly registered: readonly FileHandle[];
  readonly removed: readonly { node: Node; handle: FileHandle }[];
  readonly preopen?: string;
}
type LocalMutationAction =
  | { readonly kind: "none" }
  | {
      readonly kind: "write";
      readonly handle: FileHandle;
      readonly offset: number;
      readonly data: Uint8Array;
      readonly mtime: number;
    }
  | {
      readonly kind: "resize";
      readonly handle: FileHandle;
      readonly size: number;
      readonly truncate: boolean;
      readonly mtime: number;
    }
  | { readonly kind: "setMode"; readonly handle: FileHandle; readonly mode: number }
  | { readonly kind: "setMtime"; readonly handle: FileHandle; readonly mtime: number }
  | { readonly kind: "preopen"; readonly path: string }
  | NamespaceAction
  | {
      readonly kind: "writeFile";
      readonly namespace: NamespaceAction;
      readonly handle: FileHandle;
      readonly append: boolean;
      readonly data: Uint8Array;
      readonly offset: number;
      readonly mtime: number;
    };
interface MutationPlan {
  readonly backing?: { rollback(): void; commit(): void };
  readonly action: LocalMutationAction;
  readonly result: MutationResult;
  readonly changes: readonly PublicationEffect<FileKey>[];
}
export interface LocalMutationPlan extends Omit<MutationPlan, "changes"> {
  readonly allocation: IdentityAllocator;
  readonly identities: readonly { node: Node; handle: FileHandle; identity: FileIdentity }[];
  readonly changes: readonly PublicationEffect[];
}
export class MemoryBackend implements FilesystemBackend {
  identity(handle: FileHandle): FileIdentity {
    const node = this.fs.nodeForHandle(handle);
    return this.shared.identity(handle) ?? this.ensureIdentity(node);
  }
  ensureIdentity(node: Node): FileIdentity {
    return (node.identity ??= this.shared.identities.create());
  }
  readonly workspaceId: string;
  readonly fs: MemFS;
  constructor(
    fs = new MemFS(),
    reservation: IdentityReservation = { workspace: crypto.randomUUID(), era: 1n },
    startupRoot?: MemoryBudget | MemoryBackend,
  ) {
    if (startupRoot instanceof MemoryBackend) {
      this.fs = startupRoot.fs;
      this.workspaceId = startupRoot.workspaceId;
      this.shared = startupRoot.shared;
      this.startupRoot = startupRoot.startupRoot;
      this.sharedAttached = startupRoot.sharedAttached;
      return;
    }
    this.shared = new SharedFilesystemState(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      startupRoot,
    );
    if (this.shared.startupMemoryBudget) this.startupRoot = this.shared;
    this.fs = fs;
    this.workspaceId = reservation.workspace;
    this.shared.identities.configure(reservation);
    const seen = new Set<Node>();
    const pending: Node[] = [fs.root];
    while (pending.length) {
      const node = pending.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      this.ensureIdentity(node);
      if (node.kind === "dir") pending.push(...node.children.values());
    }
  }
  shared: SharedFilesystemState;
  private readonly startupRoot?: SharedFilesystemState;
  private sharedAttached = false;
  private directoryTimes = new Map<FileHandle, number>();
  attachShared(
    buffer: SharedArrayBuffer,
    maxBytes?: number,
    segments: readonly SharedArrayBuffer[] = [],
    publication?: PublicationBuffers,
  ): void {
    if (this.sharedAttached || this.startupRoot) {
      if (
        this.sharedAttached &&
        (!!this.shared.publication !== !!publication ||
          (publication && this.shared.publication?.buffers.history !== publication.history))
      )
        throw new FilesystemError(58, "filesystem publication root mismatch");
      // SAB wrappers change identity when cloned through a port. Probe a reserved header word
      // instead; connect runs synchronously on the sole service thread and guests never use it.
      const incoming = new Int32Array(buffer, 0, 16);
      const previous = Atomics.load(this.shared.cells, 6);
      const probe = previous ^ -1;
      Atomics.store(this.shared.cells, 6, probe);
      const same = Atomics.load(incoming, 6) === probe;
      Atomics.store(this.shared.cells, 6, previous);
      if (!same) throw new Error("filesystem service cannot attach a second shared tree");
      if (this.sharedAttached) return;
    }
    const previous = this.shared;
    this.shared = new SharedFilesystemState(
      buffer,
      maxBytes,
      undefined,
      segments,
      undefined,
      publication,
    );
    this.shared.identities.copyFrom(previous.identities);
    this.sharedAttached = true;
  }
  readMetadata(node: Node) {
    const handle = this.fs.handleForNode(node);
    return { ...this.fs.stat(handle), ...this.shared.stat(handle), ...this.identity(handle) };
  }
  selectReadBacking(
    node: Extract<Node, { kind: "file" }>,
    offset: number,
    length: number,
    full = false,
    _metadata?: ReaderMetadataBudget,
  ): ReadBacking {
    const handle = this.fs.handleForNode(node);
    if (!length) return { kind: "empty" };
    if (this.shared.hasFile(handle)) {
      return { kind: "resident", pages: this.shared.retainVersionPages(handle, offset, length) };
    }
    return {
      kind: "seed",
      bytes: full ? node.data : new Uint8Array(node.data.subarray(offset, offset + length)),
      offset: full ? 0 : offset,
      length,
    };
  }
  protected sync(handle: FileHandle): void {
    const node = this.fs.nodeForHandle(handle);
    const stat = this.fs.stat(handle);
    if (node.kind === "file")
      this.shared.register(handle, stat, node.data, true, this.ensureIdentity(node));
    else if (
      this.directoryTimes.get(handle) !== stat.mtime ||
      this.shared.stat(handle)?.mode !== stat.mode ||
      this.shared.stat(handle)?.nlink !== stat.nlink
    ) {
      this.shared.register(handle, stat, undefined, true, this.ensureIdentity(node));
      this.directoryTimes.set(handle, stat.mtime);
    }
  }
  protected identityChanged(_node: Node): void {}
  protected isLinked(node: Node): boolean {
    return this.fs.hasNode(node);
  }
  retain(handle: number): void {
    this.check(handle);
    this.fs.retain(handle);
    this.shared.retain(handle);
  }
  release(handle: number): void {
    this.shared.release(handle);
    this.fs.release(handle);
  }
  private check(handle: number, kind?: "file" | "directory"): void {
    let stat;
    try {
      stat = this.fs.stat(handle);
    } catch {
      throw new FilesystemError(8);
    }
    this.sync(handle);
    if (kind && stat.kind !== kind) throw new FilesystemError(kind === "directory" ? 54 : 31);
  }
  private path(path: ResolvedPath): void {
    if (path.parent === undefined || path.terminalDot) return;
    this.check(path.parent, "directory");
    const current = this.fs.resolve(path.parent, path.name);
    if (typeof current === "number") throw new FilesystemError(current);
    if (current.node !== path.node) throw new FilesystemError(current.node === undefined ? 44 : 20);
  }
  private existing(
    path: string,
  ): { handle: FileHandle; node: Extract<Node, { kind: "file" }> } | undefined {
    let node: Node | undefined = this.fs.lookup(path);
    if (!node && path.startsWith("/")) {
      const resolved = this.fs.resolveAbsolute(path, true);
      if (typeof resolved !== "number" && resolved.node !== undefined)
        node = this.fs.nodeForHandle(resolved.node);
    }
    if (!node || node.kind !== "file") return undefined;
    const handle = this.fs.handleForNode(node);
    this.sync(handle);
    return { handle, node };
  }
  execute(operation: string, args: any[], data: Uint8Array): unknown {
    try {
      const intent = mutationIntent(operation, args);
      if (!intent) return this.executeOperation(operation, args, data);
      return this.shared.mutate(undefined, undefined, () => this.executePublication(intent, data));
    } finally {
      if (namespaceOperations.has(operation)) this.syncDirectoryTimes();
    }
  }
  private executePublication(intent: MutationIntent, data: Uint8Array): unknown {
    const plan = this.planPublication(intent, data);
    try {
      this.prepareMutation(plan);
      this.applyPublication(plan);
    } catch (error) {
      this.discardPublication(plan);
      throw error;
    }
    return mutationValue(plan.result);
  }
  private syncDirectoryTimes(): void {
    for (const handle of this.directoryTimes.keys()) {
      try {
        this.sync(handle);
      } catch {
        this.directoryTimes.delete(handle);
      }
    }
  }
  private checkMissingParent(path: string): void {
    const parts = path.split("/").filter((part) => part.length > 0);
    for (let index = 0; index < parts.length; index++) {
      const prefix = `/${parts.slice(0, index + 1).join("/")}`;
      const resolved = this.fs.resolveAbsolute(prefix);
      if (typeof resolved === "number") throw new FilesystemError(resolved);
      if (resolved.node !== undefined) continue;
      if (parts.slice(index + 1).some((part) => part === "." || part === ".."))
        throw new FilesystemError(44);
      return;
    }
    throw new FilesystemError(44);
  }
  private executeOperation(operation: string, args: any[], _data: Uint8Array): unknown {
    const [a, b, c] = args;
    switch (operation) {
      case "flush":
        return;
      case "sync":
        this.check(a);
        return 0;
      case "resolve":
        this.check(a, "directory");
        return this.fs.resolve(a, b, c === true);
      case "readlink":
        this.check(a);
        return this.fs.readlink(a);
      case "stat":
        this.check(a);
        return this.shared.stat(a)!;
      case "permissions":
        this.check(a);
        return this.fs.permissions(a);
      case "read": {
        this.check(a, "file");
        const bytes = new Uint8Array(b);
        return bytes.subarray(0, this.shared.read(a, [bytes], c));
      }
      case "grow":
        this.publicationFile(a);
        this.shared.grow(a, b);
        return;
      case "readdir":
        this.check(a, "directory");
        return this.fs.readdir(a);
      case "resolvePath": {
        if (!a.startsWith("/"))
          throw new FilesystemError(28, "path resolution requires an absolute path");
        const resolved = this.fs.resolveAbsolute(a);
        if (typeof resolved === "number") throw new FilesystemError(resolved);
        if (resolved.node === undefined) return;
        const node = this.fs.nodeForHandle(resolved.node);
        const path = resolved.canonicalPath;
        return node.kind === "symlink"
          ? { path, kind: node.kind, target: node.target }
          : { path, kind: node.kind };
      }
      case "lookup":
        return this.lookup(a);
      case "readFile": {
        const existing = this.existing(a);
        if (!existing) return;
        const bytes = new Uint8Array(this.shared.info(existing.handle)!.size);
        return bytes.subarray(0, this.shared.read(existing.handle, [bytes], 0));
      }
      case "listFiles":
        return this.fs.listFiles(a);
      default:
        throw new FilesystemError(52, `unknown filesystem operation ${operation}`);
    }
  }
  private lookup(path: string): unknown {
    const node = this.fs.lookup(path, false);
    if (!node) return;
    const metadata = (entry: Node) => {
      const stat = this.shared.stat(this.fs.handleForNode(entry));
      return {
        kind: entry.kind,
        ino: entry.ino,
        mtime: stat?.mtime ?? entry.mtime,
        ...(entry.kind === "symlink" ? { target: entry.target } : {}),
      };
    };
    if (node.kind !== "dir") return metadata(node);
    this.fs.readdir(this.fs.handleForNode(node));
    return {
      ...metadata(node),
      children: new Map(Array.from(node.children, ([name, child]) => [name, metadata(child)])),
    };
  }
  /** Preflight runs under the existing global lock after all storage waits. It does not
   * change namespace, logical size or revision. Unsupported plans fail before any effect. */
  planPublication(intent: MutationIntent, data: Uint8Array): LocalMutationPlan {
    const allocation = this.shared.identities.stage();
    const plan = this.planMutation(intent, data, allocation);
    try {
      const identities = this.planIdentities(plan, allocation);
      const byInode = new Map(identities.map(({ node, identity }) => [node.ino, identity]));
      const reference = (key: FileKey) => {
        const identity = byInode.get(key.ino);
        if (!identity) throw new FilesystemError(29, "missing planned identity");
        return { ...key, ...identity };
      };
      return {
        ...plan,
        allocation,
        identities,
        changes: plan.changes.map((effect) => mapPublicationFiles(effect, reference)),
        backing: this.preparePublicationBacking(plan.action),
      };
    } catch (error) {
      this.discardPublication(plan);
      throw error;
    }
  }
  private preparePublicationBacking(action: LocalMutationAction) {
    if (action.kind !== "write" && action.kind !== "resize" && action.kind !== "writeFile") return;
    const old = this.shared.stat(action.handle)!.size;
    if (action.kind === "resize") {
      const length =
        action.truncate && action.size < old
          ? truncateBoundaryEnd(action.size, old) - action.size
          : 0;
      return this.shared.prepareVersionWrite(action.handle, action.size, length, action.size);
    }
    const length =
      action.kind === "writeFile" && !action.append
        ? Math.max(old, action.data.length)
        : action.data.length;
    return this.shared.prepareVersionWrite(
      action.handle,
      action.offset,
      length,
      action.offset + action.data.length,
    );
  }
  private planIdentities(
    plan: MutationPlan,
    allocation: IdentityAllocator,
  ): { node: Node; handle: FileHandle; identity: FileIdentity }[] {
    if (!plan.changes.length) return [];
    const action = plan.action.kind === "writeFile" ? plan.action.namespace : plan.action;
    const nodes = new Set<Node>();
    if (action.kind === "namespace") this.namespaceIdentityNodes(action.plan, nodes);
    if ("handle" in plan.action) nodes.add(this.fs.nodeForHandle(plan.action.handle));
    const existing = Array.from(nodes).filter(
      (node) => action.kind !== "namespace" || !action.plan.created.includes(node),
    );
    const versions = allocation.versions(existing.length);
    const updated = new Map(existing.map((node, index) => [node, versions[index]!]));
    return Array.from(nodes, (node) => {
      const handle = this.fs.handleForNode(node),
        identity = this.identity(handle);
      return {
        node,
        handle,
        identity: { id: identity.id, version: updated.get(node) ?? identity.version },
      };
    });
  }
  private namespaceIdentityNodes(plan: NamespacePlan, nodes: Set<Node>): void {
    for (const node of plan.parents) nodes.add(node);
    for (const node of plan.created) nodes.add(node);
    for (const edge of plan.edges) {
      if (edge.before) nodes.add(edge.before);
      if (edge.after) nodes.add(edge.after);
    }
  }
  private get effectBound(): number {
    return this.shared.publication?.limits.effects ?? Number.MAX_SAFE_INTEGER;
  }
  private planMutation(
    intent: MutationIntent,
    data: Uint8Array,
    allocation: IdentityAllocator,
  ): MutationPlan {
    const domain = this.shared.publication;
    domain?.assertLive();
    switch (intent.kind) {
      case "write":
      case "append":
        return this.planPublicationWrite(intent, data);
      case "resize":
        return this.planPublicationResize(intent);
      case "setMode":
        return this.planPublicationMode(intent);
      case "setMtime":
        return this.planPublicationMtime(intent);
      case "preopen":
      case "mkdirp": {
        const prepared = this.fs.planMkdirp(intent.path, this.effectBound);
        const handle = this.fs.handleForNode(prepared.node);
        return this.planNamespace(
          prepared.plan,
          intent.kind === "preopen" ? { kind: "number", value: handle } : { kind: "void" },
          allocation,
          intent.kind === "preopen" ? intent.path : undefined,
        );
      }
      case "create": {
        if (intent.path.parent !== undefined) this.check(intent.path.parent, "directory");
        const prepared = this.fs.planCreate(
          intent.path,
          intent.nodeKind,
          intent.exclusive,
          this.effectBound,
        );
        return this.planNamespace(
          prepared.plan,
          typeof prepared.result === "number"
            ? { kind: "number", value: prepared.result }
            : { kind: "create-error", errno: prepared.result.error },
          allocation,
        );
      }
      case "symlink": {
        this.path(intent.path);
        const prepared = this.fs.planSymlink(intent.path, intent.target, this.effectBound);
        return this.planNamespace(
          prepared.plan,
          { kind: "number", value: prepared.result },
          allocation,
        );
      }
      case "link":
      case "rename": {
        this.path(intent.from);
        this.path(intent.to);
        const prepared =
          intent.kind === "link"
            ? this.fs.planLink(intent.from, intent.to, this.effectBound)
            : this.fs.planRename(intent.from, intent.to, this.effectBound);
        return this.planNamespace(
          prepared.plan,
          { kind: "number", value: prepared.result },
          allocation,
        );
      }
      case "removePath": {
        this.path(intent.path);
        const prepared = this.fs.planRemovePath(intent.path, intent.directory, this.effectBound);
        return this.planNamespace(
          prepared.plan,
          { kind: "number", value: prepared.result },
          allocation,
        );
      }
      case "remove": {
        const prepared = this.fs.planRemove(intent.path, this.effectBound);
        return this.planNamespace(
          prepared.plan,
          { kind: "boolean", value: prepared.result },
          allocation,
        );
      }
      case "move": {
        const root = this.fs.preopen("/");
        const from = this.fs.resolve(root, intent.from.replace(/^\//, "")),
          to = this.fs.resolve(root, intent.to.replace(/^\//, ""));
        if (typeof from === "number" || typeof to === "number")
          return {
            action: { kind: "none" },
            result: {
              kind: "number",
              value: typeof from === "number" ? from : typeof to === "number" ? to : 28,
            },
            changes: [],
          };
        const prepared = this.fs.planRename(from, to, this.effectBound);
        return this.planNamespace(
          prepared.plan,
          { kind: "number", value: prepared.result },
          allocation,
        );
      }
      case "writeFile":
        return this.planPublicationHostWrite(intent, data, allocation);
      default: {
        const exhaustive: never = intent;
        return exhaustive;
      }
    }
  }
  private planNamespace(
    plan: NamespacePlan,
    result: MutationResult,
    allocation: IdentityAllocator,
    preopen?: string,
  ): MutationPlan {
    const changes: PublicationEffect<FileKey>[] = [];
    for (const node of plan.created)
      changes.push({
        kind: "inode",
        file: this.publicationKey(node.ino),
        ...(node.kind === "symlink"
          ? { nodeKind: "symlink", target: node.target }
          : { nodeKind: node.kind === "dir" ? "directory" : "file" }),
        mode: node.mode,
        mtime: plan.mtime,
      });
    for (const edge of plan.edges)
      changes.push({
        kind: "entry",
        parent: this.publicationKey(edge.parent.ino),
        name: edge.name,
        before: edge.before ? this.publicationKey(edge.before.ino) : null,
        after: edge.after ? this.publicationKey(edge.after.ino) : null,
      });
    for (const parent of plan.parents)
      changes.push({
        kind: "metadata",
        file: this.publicationKey(parent.ino),
        mode: parent.mode,
        mtime: plan.mtime,
      });
    const registered: FileHandle[] = [];
    try {
      for (const node of plan.created) {
        node.identity ??= allocation.create();
        const handle = this.fs.handleForNode(node);
        registered.push(handle);
        this.sync(handle);
      }
      const removed = plan.edges.flatMap((edge) =>
        edge.before ? [{ node: edge.before, handle: this.fs.handleForNode(edge.before) }] : [],
      );
      return {
        action: { kind: "namespace", plan, registered, removed, ...(preopen ? { preopen } : {}) },
        result,
        changes,
      };
    } catch (error) {
      for (const handle of registered) this.shared.unlink(handle);
      this.fs.discardNamespace(plan);
      throw error;
    }
  }
  discardPublication(plan: Pick<MutationPlan, "action" | "backing">): void {
    plan.backing?.rollback();
    const action = plan.action.kind === "writeFile" ? plan.action.namespace : plan.action;
    if (action.kind !== "namespace") return;
    for (const handle of action.registered) this.shared.unlink(handle);
    this.fs.discardNamespace(action.plan);
  }
  private planPublicationHostWrite(
    intent: Extract<MutationIntent, { kind: "writeFile" }>,
    data: Uint8Array,
    allocation: IdentityAllocator,
  ): MutationPlan {
    if (intent.append && intent.exclusive) throw new FilesystemError(28);
    const resolved = this.fs.resolveAbsolute(intent.path, false);
    if (typeof resolved === "number" && resolved !== 44) throw new FilesystemError(resolved);
    if (typeof resolved === "number") this.checkMissingParent(intent.path);
    if (typeof resolved !== "number" && resolved.node !== undefined && intent.exclusive)
      throw new FilesystemError(20);
    if (intent.path.endsWith("/")) throw new FilesystemError(54);
    const prepared = this.fs.planHostFile(intent.path, intent.exclusive, this.effectBound);
    const namespace = this.planNamespace(prepared.plan, { kind: "void" }, allocation);
    if (namespace.action.kind !== "namespace") throw new FilesystemError(29);
    try {
      const handle = this.fs.handleForNode(prepared.node);
      const info = this.publicationFile(handle),
        offset = intent.append ? info.size : 0;
      const size = offset + data.length;
      if (!Number.isSafeInteger(size)) throw new FilesystemError(28);
      const file = this.publicationKey(info.ino),
        version = this.shared.publication?.nextContentVersion(info.ino) ?? 0;
      const mtime = prepared.plan.mtime,
        changes = namespace.changes.slice();
      if (intent.append && !data.length && !changes.length)
        return { action: { kind: "none" }, result: { kind: "void" }, changes: [] };
      if (!intent.append && size !== info.size)
        changes.push({ kind: "resize", file, size, version });
      if (data.length) changes.push({ kind: "bytes", file, offset, bytes: data, size, version });
      if (info.mode !== prepared.node.mode || info.mtime !== mtime)
        changes.push({ kind: "metadata", file, mode: prepared.node.mode, mtime });
      if (!changes.length) return { action: { kind: "none" }, result: { kind: "void" }, changes };
      return {
        action: {
          kind: "writeFile",
          namespace: namespace.action,
          handle,
          append: intent.append,
          data,
          offset,
          mtime,
        },
        result: { kind: "void" },
        changes,
      };
    } catch (error) {
      this.discardPublication(namespace);
      throw error;
    }
  }
  private applyNamespace(action: NamespaceAction): void {
    this.fs.applyNamespace(action.plan);
    const changed = new Set<Node>();
    for (const edge of action.plan.edges) {
      if (edge.before) changed.add(edge.before);
      if (edge.after) changed.add(edge.after);
    }
    for (const node of changed) {
      const handle = this.fs.existingHandle(node);
      if (handle !== undefined) this.shared.setNlink(handle, this.fs.linkCount(node));
    }
    for (const link of action.plan.links) {
      if (link.delta > 0) this.shared.relink(this.fs.handleForNode(link.node));
    }
    for (const handle of action.registered) this.shared.setMtime(handle, action.plan.mtime);
    for (const parent of action.plan.parents) {
      const handle = this.fs.handleForNode(parent);
      if (this.shared.stat(handle)) this.sync(handle);
    }
    for (const entry of action.removed) {
      if (this.isLinked(entry.node)) continue;
      this.shared.unlink(entry.handle);
      if (this.shared.revision(entry.handle) === undefined)
        this.shared.publication?.forgetContent(entry.node.ino);
    }
    if (action.preopen) this.sync(this.fs.preopen(action.preopen));
  }
  private publicationFile(handle: FileHandle) {
    this.check(handle, "file");
    const info = this.shared.info(handle)!;
    if (info.mode !== undefined && !(info.mode & 0o200)) throw new FilesystemError(2);
    return info;
  }
  private publicationKey(ino: number) {
    return { birthHistory: this.shared.publication?.buffers.history ?? this.workspaceId, ino };
  }
  private planPublicationWrite(
    intent: Extract<MutationIntent, { kind: "write" | "append" }>,
    data: Uint8Array,
  ): MutationPlan {
    const info = this.publicationFile(intent.handle);
    const offset = intent.kind === "append" ? info.size : intent.offset;
    const end = offset + data.length;
    if (!Number.isSafeInteger(end)) throw new FilesystemError(28);
    const result: MutationResult =
      intent.kind === "append"
        ? { kind: "append", written: data.length, offset: end }
        : { kind: "number", value: data.length };
    if (!data.length) return { action: { kind: "none" }, result, changes: [] };
    this.shared.checkDirtyGrowth(intent.handle, Math.max(info.size, end));
    const file = this.publicationKey(info.ino),
      mtime = Date.now();
    return {
      action: { kind: "write", handle: intent.handle, offset, data, mtime },
      result,
      changes: [
        {
          kind: "bytes",
          file,
          offset,
          bytes: data,
          size: Math.max(info.size, end),
          version: this.shared.publication?.nextContentVersion(info.ino) ?? 0,
        },
        { kind: "metadata", file, mode: info.mode ?? 0o600, mtime },
      ],
    };
  }
  private planPublicationResize(intent: Extract<MutationIntent, { kind: "resize" }>): MutationPlan {
    const info = this.publicationFile(intent.handle);
    const size = intent.truncate ? intent.size : Math.max(info.size, intent.size);
    const file = this.publicationKey(info.ino),
      mtime = intent.truncate ? Date.now() : info.mtime;
    const changes: PublicationEffect<FileKey>[] = [];
    if (size !== info.size)
      changes.push({
        kind: "resize",
        file,
        size,
        version: this.shared.publication?.nextContentVersion(info.ino) ?? 0,
      });
    if (mtime !== info.mtime)
      changes.push({ kind: "metadata", file, mode: info.mode ?? 0o600, mtime });
    return {
      action: {
        kind: "resize",
        handle: intent.handle,
        size: intent.size,
        truncate: intent.truncate,
        mtime,
      },
      result: { kind: "number", value: 0 },
      changes,
    };
  }
  private planPublicationMode(intent: Extract<MutationIntent, { kind: "setMode" }>): MutationPlan {
    this.check(intent.handle);
    const supported = this.fs.permissions(intent.handle).modeSupported;
    if (intent.mode > 0xffffffff)
      return { action: { kind: "none" }, result: { kind: "number", value: 28 }, changes: [] };
    if (intent.mode & ~supported)
      return { action: { kind: "none" }, result: { kind: "number", value: 58 }, changes: [] };
    const stat = this.shared.stat(intent.handle)!;
    const changes: PublicationEffect<FileKey>[] =
      stat.mode === intent.mode
        ? []
        : [
            {
              kind: "metadata",
              file: this.publicationKey(stat.ino),
              mode: intent.mode,
              mtime: stat.mtime,
            },
          ];
    return {
      action: { kind: "setMode", handle: intent.handle, mode: intent.mode },
      result: { kind: "number", value: 0 },
      changes,
    };
  }
  private planPublicationMtime(
    intent: Extract<MutationIntent, { kind: "setMtime" }>,
  ): MutationPlan {
    this.check(intent.handle);
    if (!(this.fs.permissions(intent.handle).access & 2)) throw new FilesystemError(2);
    const stat = this.shared.stat(intent.handle)!;
    const changes: PublicationEffect<FileKey>[] =
      stat.mtime === intent.mtime
        ? []
        : [
            {
              kind: "metadata",
              file: this.publicationKey(stat.ino),
              mode: stat.mode ?? 0o600,
              mtime: intent.mtime,
            },
          ];
    return {
      action: { kind: "setMtime", handle: intent.handle, mtime: intent.mtime },
      result: { kind: "number", value: 0 },
      changes,
    };
  }
  protected admitMutation(_plan: LocalMutationPlan): void {}
  prepareMutation(plan: LocalMutationPlan): void {
    this.admitMutation(plan);
  }
  /** Only this synchronous typed switch applies a publication-aware service mutation. */
  applyPublication(plan: LocalMutationPlan): void {
    this.shared.identityGroup = true;
    try {
      plan.backing?.commit();
      this.shared.identities.copyFrom(plan.allocation);
      this.applyMutation(plan);
      for (const { node, handle, identity } of plan.identities) {
        node.identity = identity;
        this.identityChanged(node);
        this.shared.updateIdentity(handle, identity);
      }
      this.shared.watch.effects(plan.changes);
    } finally {
      this.shared.identityGroup = false;
    }
  }
  private applyMutation(plan: LocalMutationPlan): void {
    const action = plan.action;
    switch (action.kind) {
      case "none":
        return;
      case "write":
        this.shared.write(action.handle, [action.data], action.offset);
        this.shared.setMtime(action.handle, action.mtime);
        this.fs.setMtime(action.handle, action.mtime);
        return;
      case "resize":
        this.shared.resize(action.handle, action.size, action.truncate);
        if (action.truncate) this.shared.setMtime(action.handle, action.mtime);
        if (action.truncate) this.shared.reclaimLocked(action.handle);
        return;
      case "setMode":
        this.fs.setMode(action.handle, action.mode);
        this.shared.setMode(action.handle, action.mode);
        return;
      case "setMtime":
        this.fs.setMtime(action.handle, action.mtime);
        this.shared.setMtime(action.handle, action.mtime);
        return;
      case "preopen":
        this.sync(this.fs.preopen(action.path));
        return;
      case "namespace":
        this.applyNamespace(action);
        return;
      case "writeFile":
        this.applyNamespace(action.namespace);
        if (!action.append) this.shared.resize(action.handle, 0, true);
        if (action.data.length) this.shared.write(action.handle, [action.data], action.offset);
        this.shared.setMtime(action.handle, action.mtime);
        this.fs.setMtime(action.handle, action.mtime);
        if (!action.append) this.shared.reclaimLocked(action.handle);
        return;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }
  revokeOwner(owner: number, epoch?: Int32Array): void {
    this.shared.revokeOwner(owner, epoch);
  }
  takeSharedSegments(): SharedSegment[] {
    return this.shared.takeNewSegments();
  }
  sharedSegments(): SharedSegment[] {
    return this.shared.segments
      .slice(1)
      .flatMap((buffer, index) => (buffer.byteLength ? [{ buffer, index: index + 1 }] : []));
  }
  resources(): Record<string, number> {
    return {
      ...this.shared.resources(),
      startupRootBackingBytes: this.startupRoot?.buffer.byteLength ?? 0,
    };
  }
}
