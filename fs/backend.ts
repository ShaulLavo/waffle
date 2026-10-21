import type { MutationIntent, MutationResult, PublicationEffect } from "./publication.js";
import type { PublicationBuffers } from "./publication-internal.js";
import { normalize, dirname, type FileHandle, type ResolvedPath } from "../core/index.js";
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
  /** File identity/path limits explicit durability to that file; omitted flushes the workspace. */
  flush?(target?: FileHandle | string): Promise<void>;
  /** Release startup resources when cancellation races backend creation. */
  close?(): Promise<void>;
}
const namespaceOperations = new Set([
  "preopen",
  "create",
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
  | { readonly kind: "write"; readonly handle: FileHandle; readonly offset: number; readonly data: Uint8Array; readonly mtime: number }
  | { readonly kind: "resize"; readonly handle: FileHandle; readonly size: number; readonly truncate: boolean; readonly mtime: number }
  | { readonly kind: "setMode"; readonly handle: FileHandle; readonly mode: number }
  | { readonly kind: "setMtime"; readonly handle: FileHandle; readonly mtime: number }
  | { readonly kind: "preopen"; readonly path: string }
  | NamespaceAction
  | { readonly kind: "writeFile"; readonly namespace: NamespaceAction; readonly handle: FileHandle; readonly append: boolean; readonly data: Uint8Array; readonly offset: number; readonly mtime: number };
export interface LocalMutationPlan {
  readonly action: LocalMutationAction;
  readonly result: MutationResult;
  readonly changes: readonly PublicationEffect[];
}
export class MemoryBackend implements FilesystemBackend {
  readonly fs: MemFS;
  constructor(fs = new MemFS()) {
    this.fs = fs;
  }
  shared = new SharedFilesystemState();
  private sharedAttached = false;
  private directoryTimes = new Map<FileHandle, number>();
  attachShared(
    buffer: SharedArrayBuffer,
    maxBytes?: number,
    segments: readonly SharedArrayBuffer[] = [],
    publication?: PublicationBuffers,
  ): void {
    if (this.sharedAttached) {
      if (!!this.shared.publication !== !!publication || (publication && this.shared.publication?.buffers.history !== publication.history))
        throw new FilesystemError(58, "filesystem publication root mismatch");
      // SAB wrappers change identity when cloned through a port. Probe a reserved header word
      // instead; connect runs synchronously on the sole service thread and guests never use it.
      const incoming = new Int32Array(buffer, 0, 16);
      const previous = Atomics.load(this.shared.cells, 6);
      const probe = previous ^ -1;
      Atomics.store(this.shared.cells, 6, probe);
      const same = Atomics.load(incoming, 6) === probe;
      Atomics.store(this.shared.cells, 6, previous);
      if (same) return;
      throw new Error("filesystem service cannot attach a second shared tree");
    }
    this.shared = new SharedFilesystemState(buffer, maxBytes, undefined, segments, undefined, publication);
    this.sharedAttached = true;
  }
  protected sync(handle: FileHandle): void {
    const node = this.fs.nodeForHandle(handle);
    const stat = this.fs.stat(handle);
    if (node.kind === "file") this.shared.register(handle, stat, node.data);
    else if (
      this.directoryTimes.get(handle) !== stat.mtime ||
      this.shared.stat(handle)?.mode !== stat.mode
    ) {
      this.shared.register(handle, stat);
      this.directoryTimes.set(handle, stat.mtime);
    }
  }
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
    let node = this.fs.lookup(path);
    if (!node && path.startsWith("/")) {
      const resolved = this.fs.resolveAbsolute(path);
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
      return this.executeOperation(operation, args, data);
    } finally {
      if (namespaceOperations.has(operation))
        for (const handle of this.directoryTimes.keys()) {
          try {
            this.sync(handle);
          } catch {
            this.directoryTimes.delete(handle);
          }
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
  private mkdirParents(path: string): void {
    try {
      this.fs.mkdirp(dirname(path));
    } catch (error) {
      if (error instanceof FilesystemError) throw error;
      throw new FilesystemError(54);
    }
  }
  private createExclusive(path: string, data: Uint8Array): void {
    // Resolve the actual tree before normalization so missing/.. and file/.. cannot
    // silently change the target. The service queue serializes namespace creation.
    const target = normalize(path);
    let resolved = this.fs.resolveAbsolute(path);
    if (typeof resolved === "number") {
      if (resolved !== 44) throw new FilesystemError(resolved);
      if (path.endsWith("/")) throw new FilesystemError(54);
      this.checkMissingParent(path);
      this.mkdirParents(target);
      resolved = this.fs.resolveAbsolute(target);
      if (typeof resolved === "number") throw new FilesystemError(resolved);
    }
    if (resolved.node !== undefined) throw new FilesystemError(20);
    if (resolved.trailingSlash) throw new FilesystemError(54);
    const result = this.fs.create(resolved, "file", true);
    if (typeof result !== "number") throw new FilesystemError(result.error);
    try {
      this.fs.writeFile(target, data.slice(), false);
      this.sync(result);
    } catch (error) {
      this.fs.remove(target);
      throw error;
    }
  }
  private writeExisting(handle: FileHandle, append: boolean, data: Uint8Array): void {
    if (!(this.fs.permissions(handle).access & 2)) throw new FilesystemError(2);
    if (append && !data.length) return;
    this.shared.mutate(undefined, undefined, () => {
      const offset = append ? this.shared.info(handle)!.size : 0;
      this.shared.growLocked(handle, offset + data.length);
      if (!append) this.shared.resize(handle, 0, true);
      this.shared.write(handle, [data], offset);
      if (!append) this.shared.reclaimLocked(handle);
      this.fs.setMtime(handle, Date.now());
    });
  }
  private writeFile(path: string, append: boolean, exclusive: boolean, data: Uint8Array): void {
    if (append && exclusive)
      throw new FilesystemError(28, "writeFile cannot append and create exclusively");
    if (exclusive) return this.createExclusive(path, data);
    const existing = this.existing(path);
    if (existing) return this.writeExisting(existing.handle, append, data);
    this.fs.writeFile(path, data.slice(), false);
    try {
      const created = this.existing(path);
      if (created) this.sync(created.handle);
    } catch (error) {
      this.fs.remove(path);
      throw error;
    }
  }
  private executeOperation(operation: string, args: any[], data: Uint8Array): unknown {
    const [a, b, c] = args;
    if (["write", "append", "grow", "resize"].includes(operation)) {
      this.check(a, "file");
      if (!(this.fs.permissions(a).access & 2)) throw new FilesystemError(2);
    }
    switch (operation) {
      case "flush":
        return;
      case "sync":
        this.check(a);
        return 0;
      case "preopen": {
        const handle = this.fs.preopen(a);
        this.sync(handle);
        return handle;
      }
      case "resolve":
        this.check(a, "directory");
        return this.fs.resolve(a, b);
      case "stat":
        this.check(a);
        return this.shared.stat(a)!;
      case "permissions":
        this.check(a);
        return this.fs.permissions(a);
      case "setMode": {
        this.check(a);
        const error = this.fs.setMode(a, b);
        if (!error) this.shared.setMode(a, b);
        return error;
      }
      case "read": {
        this.check(a, "file");
        const bytes = new Uint8Array(b);
        const count = this.shared.read(a, [bytes], c);
        return bytes.subarray(0, count);
      }
      case "write":
        this.check(a, "file");
        if (!data.length) return 0;
        return this.shared.mutate(undefined, undefined, () => {
          this.shared.growLocked(a, b + data.length);
          const result = this.shared.write(a, [data], b);
          this.fs.setMtime(a, Date.now());
          return result;
        });
      case "append": {
        this.check(a, "file");
        if (!data.length) return { written: 0, offset: this.shared.info(a)!.size };
        return this.shared.mutate(undefined, undefined, () => {
          const info = this.shared.info(a)!;
          this.shared.growLocked(a, info.size + data.length);
          const result = this.shared.append(a, [data]);
          this.fs.setMtime(a, Date.now());
          return result;
        });
      }
      case "grow":
        this.check(a, "file");
        this.shared.grow(a, b);
        return;
      case "resize":
        this.check(a, "file");
        return this.shared.mutate(undefined, undefined, () => {
          this.shared.growLocked(a, b);
          const result = this.shared.resize(a, b, c);
          if (c) this.shared.reclaimLocked(a);
          return result;
        });
      case "setMtime":
        this.check(a);
        if (this.fs.setMtime(a, b)) return 2;
        return this.shared.mutate(undefined, undefined, () => this.shared.setMtime(a, b));
      case "readdir":
        this.check(a, "directory");
        return this.fs.readdir(a);
      case "create": {
        if (a.parent !== undefined) this.check(a.parent, "directory");
        const result = this.fs.create(a, b, c);
        if (typeof result === "number") this.sync(result);
        return result;
      }
      case "link": {
        this.path(a);
        this.path(b);
        const result = this.fs.link(a, b);
        if (!result && a.node !== undefined) this.shared.relink(a.node);
        return result;
      }
      case "removePath": {
        this.path(a);
        const handle = a.node;
        const removed = handle === undefined ? undefined : this.fs.nodeForHandle(handle);
        const result = this.fs.removePath(a, b);
        if (!result && handle !== undefined && removed && !this.isLinked(removed))
          this.shared.unlink(handle);
        return result;
      }
      case "rename": {
        this.path(a);
        this.path(b);
        const target = b.node;
        const replaced = target === undefined ? undefined : this.fs.nodeForHandle(target);
        const result = this.fs.rename(a, b);
        if (
          !result &&
          target !== undefined &&
          target !== a.node &&
          replaced &&
          !this.isLinked(replaced)
        )
          this.shared.unlink(target);
        return result;
      }
      case "resolvePath": {
        if (!a.startsWith("/"))
          throw new FilesystemError(28, "path resolution requires an absolute path");
        const resolved = this.fs.resolveAbsolute(a);
        if (typeof resolved === "number") throw new FilesystemError(resolved);
        if (resolved.node === undefined) return undefined;
        // This tree has no symlinks: normalize only after the real walk has validated
        // every intermediate component, including those followed by dot segments.
        return { path: normalize(a), kind: this.fs.nodeForHandle(resolved.node).kind };
      }
      case "lookup": {
        const node = this.fs.lookup(a);
        if (!node) return undefined;
        const metadata = (entry: Node) => {
          const handle = this.fs.handleForNode(entry);
          const stat = this.shared.stat(handle);
          return { kind: entry.kind, ino: entry.ino, mtime: stat?.mtime ?? entry.mtime };
        };
        if (node.kind === "dir") this.fs.readdir(this.fs.handleForNode(node));
        return node.kind === "file"
          ? metadata(node)
          : {
              ...metadata(node),
              children: new Map(
                Array.from(node.children, ([name, child]) => [name, metadata(child)]),
              ),
            };
      }
      case "readFile": {
        const existing = this.existing(a);
        if (!existing) return undefined;
        const bytes = new Uint8Array(this.shared.info(existing.handle)!.size);
        const count = this.shared.read(existing.handle, [bytes], 0);
        return bytes.subarray(0, count);
      }
      case "writeFile":
        return this.writeFile(a, b, c, data);
      case "mkdirp":
        this.fs.mkdirp(a);
        return;
      case "remove": {
        const detached: { node: Node; handle: FileHandle }[] = [];
        const collect = (node: Node) => {
          detached.push({ node, handle: this.fs.handleForNode(node) });
          if (node.kind === "dir") for (const child of node.children.values()) collect(child);
        };
        const node = this.fs.lookup(a);
        if (node) collect(node);
        const result = this.fs.remove(a);
        if (result)
          for (const entry of detached)
            if (!this.isLinked(entry.node)) this.shared.unlink(entry.handle);
        return result;
      }
      case "listFiles":
        return this.fs.listFiles(a);
      case "move": {
        const root = this.fs.preopen("/");
        this.sync(root);
        const from = this.fs.resolve(root, a.replace(/^\//, ""));
        const to = this.fs.resolve(root, b.replace(/^\//, ""));
        if (typeof from === "number") return from;
        if (typeof to === "number") return to;
        const target = to.node;
        const replaced = target === undefined ? undefined : this.fs.nodeForHandle(target);
        const result = this.fs.rename(from, to);
        if (
          !result &&
          target !== undefined &&
          target !== from.node &&
          replaced &&
          !this.isLinked(replaced)
        )
          this.shared.unlink(target);
        return result;
      }
      default:
        throw new FilesystemError(52, `unknown filesystem operation ${operation}`);
    }
  }
  /** Preflight runs under the existing global lock after all storage waits. It does not
   * change namespace, logical size or revision. Unsupported plans fail before any effect. */
  planPublication(intent: MutationIntent, data: Uint8Array): LocalMutationPlan {
    const domain = this.shared.publication;
    if (!domain) throw new FilesystemError(28);
    domain.assertLive();
    switch (intent.kind) {
      case "write": case "append": return this.planPublicationWrite(intent, data);
      case "resize": return this.planPublicationResize(intent);
      case "setMode": return this.planPublicationMode(intent);
      case "setMtime": return this.planPublicationMtime(intent);
      case "preopen": case "mkdirp": {
        const prepared = this.fs.planMkdirp(intent.path, domain.limits.effects);
        const handle = this.fs.handleForNode(prepared.node);
        return this.planNamespace(prepared.plan, intent.kind === "preopen" ? { kind: "number", value: handle } : { kind: "void" }, intent.kind === "preopen" ? intent.path : undefined);
      }
      case "create": {
        this.path(intent.path);
        const prepared = this.fs.planCreate(intent.path, intent.nodeKind, intent.exclusive, domain.limits.effects);
        return this.planNamespace(prepared.plan, typeof prepared.result === "number" ? { kind: "number", value: prepared.result } : { kind: "create-error", errno: prepared.result.error });
      }
      case "link": case "rename": {
        this.path(intent.from); this.path(intent.to);
        const prepared = intent.kind === "link" ? this.fs.planLink(intent.from, intent.to, domain.limits.effects) : this.fs.planRename(intent.from, intent.to, domain.limits.effects);
        return this.planNamespace(prepared.plan, { kind: "number", value: prepared.result });
      }
      case "removePath": {
        this.path(intent.path);
        const prepared = this.fs.planRemovePath(intent.path, intent.directory, domain.limits.effects);
        return this.planNamespace(prepared.plan, { kind: "number", value: prepared.result });
      }
      case "remove": {
        const prepared = this.fs.planRemove(intent.path, domain.limits.effects);
        return this.planNamespace(prepared.plan, { kind: "boolean", value: prepared.result });
      }
      case "move": {
        const root = this.fs.preopen("/");
        const from = this.fs.resolve(root, intent.from.replace(/^\//, "")), to = this.fs.resolve(root, intent.to.replace(/^\//, ""));
        if (typeof from === "number" || typeof to === "number") return { action: { kind: "none" }, result: { kind: "number", value: typeof from === "number" ? from : typeof to === "number" ? to : 28 }, changes: [] };
        const prepared = this.fs.planRename(from, to, domain.limits.effects);
        return this.planNamespace(prepared.plan, { kind: "number", value: prepared.result });
      }
      case "writeFile": return this.planPublicationHostWrite(intent, data);
      default: { const exhaustive: never = intent; return exhaustive; }
    }
  }
  private planNamespace(plan: NamespacePlan, result: MutationResult, preopen?: string): LocalMutationPlan {
    const changes: PublicationEffect[] = [];
    for (const node of plan.created) changes.push({ kind: "inode", file: this.publicationKey(node.ino), nodeKind: node.kind === "dir" ? "directory" : "file", mode: node.mode, mtime: plan.mtime });
    for (const edge of plan.edges) changes.push({ kind: "entry", parent: this.publicationKey(edge.parent.ino), name: edge.name, before: edge.before ? this.publicationKey(edge.before.ino) : null, after: edge.after ? this.publicationKey(edge.after.ino) : null });
    for (const parent of plan.parents) changes.push({ kind: "metadata", file: this.publicationKey(parent.ino), mode: parent.mode, mtime: plan.mtime });
    const registered: FileHandle[] = [];
    try {
      for (const node of plan.created) {
        const handle = this.fs.handleForNode(node);
        registered.push(handle);
        this.sync(handle);
      }
      const removed = plan.edges.flatMap((edge) => edge.before ? [{ node: edge.before, handle: this.fs.handleForNode(edge.before) }] : []);
      return { action: { kind: "namespace", plan, registered, removed, ...(preopen ? { preopen } : {}) }, result, changes };
    } catch (error) {
      for (const handle of registered) this.shared.unlink(handle);
      this.fs.discardNamespace(plan);
      throw error;
    }
  }
  discardPublication(plan: LocalMutationPlan): void {
    const action = plan.action.kind === "writeFile" ? plan.action.namespace : plan.action;
    if (action.kind !== "namespace") return;
    for (const handle of action.registered) this.shared.unlink(handle);
    this.fs.discardNamespace(action.plan);
  }
  private planPublicationHostWrite(intent: Extract<MutationIntent, {kind: "writeFile"}>, data: Uint8Array): LocalMutationPlan {
    if (intent.append && intent.exclusive) throw new FilesystemError(28);
    const resolved = this.fs.resolveAbsolute(intent.path);
    if (typeof resolved === "number" && resolved !== 44) throw new FilesystemError(resolved);
    if (typeof resolved === "number") this.checkMissingParent(intent.path);
    if (intent.path.endsWith("/")) throw new FilesystemError(54);
    const prepared = this.fs.planHostFile(normalize(intent.path), intent.exclusive, this.shared.publication!.limits.effects);
    const namespace = this.planNamespace(prepared.plan, {kind: "void"});
    if (namespace.action.kind !== "namespace") throw new FilesystemError(29);
    try {
      const handle = this.fs.handleForNode(prepared.node);
      const info = this.publicationFile(handle), offset = intent.append ? info.size : 0;
      const size = offset + data.length;
      if (!Number.isSafeInteger(size)) throw new FilesystemError(28);
      this.shared.growLocked(handle, size);
      const file = this.publicationKey(info.ino), version = this.shared.publication!.nextContentVersion(info.ino);
      const mtime = prepared.plan.mtime, changes = namespace.changes.slice();
      if (intent.append && !data.length && !changes.length) return {action: {kind: "none"}, result: {kind: "void"}, changes: []};
      if (!intent.append && size !== info.size) changes.push({kind: "resize", file, size, version});
      if (data.length) changes.push({kind: "bytes", file, offset, bytes: data, size, version});
      changes.push({kind: "metadata", file, mode: prepared.node.mode, mtime});
      return {action: {kind: "writeFile", namespace: namespace.action, handle, append: intent.append, data, offset, mtime}, result: {kind: "void"}, changes};
    } catch (error) { this.discardPublication(namespace); throw error; }
  }
  private applyNamespace(action: NamespaceAction): void {
    this.fs.applyNamespace(action.plan);
    for (const handle of action.registered) this.shared.setMtime(handle, action.plan.mtime);
    for (const parent of action.plan.parents) this.sync(this.fs.handleForNode(parent));
    for (const entry of action.removed) {
      if (this.isLinked(entry.node)) continue;
      this.shared.unlink(entry.handle);
      if (this.shared.revision(entry.handle) === undefined) this.shared.publication!.forgetContent(entry.node.ino);
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
    return { birthHistory: this.shared.publication!.buffers.history, ino };
  }
  private planPublicationWrite(intent: Extract<MutationIntent, { kind: "write" | "append" }>, data: Uint8Array): LocalMutationPlan {
    const info = this.publicationFile(intent.handle);
    const offset = intent.kind === "append" ? info.size : intent.offset;
    const end = offset + data.length;
    if (!Number.isSafeInteger(end)) throw new FilesystemError(28);
    const result: MutationResult = intent.kind === "append" ? { kind: "append", written: data.length, offset: end } : { kind: "number", value: data.length };
    if (!data.length) return { action: { kind: "none" }, result, changes: [] };
    this.shared.growLocked(intent.handle, end);
    const file = this.publicationKey(info.ino), mtime = Date.now();
    return {
      action: { kind: "write", handle: intent.handle, offset, data, mtime }, result,
      changes: [
        { kind: "bytes", file, offset, bytes: data, size: Math.max(info.size, end), version: this.shared.publication!.nextContentVersion(info.ino) },
        { kind: "metadata", file, mode: info.mode ?? 0o600, mtime },
      ],
    };
  }
  private planPublicationResize(intent: Extract<MutationIntent, { kind: "resize" }>): LocalMutationPlan {
    const info = this.publicationFile(intent.handle);
    this.shared.growLocked(intent.handle, intent.size);
    const size = intent.truncate ? intent.size : Math.max(info.size, intent.size);
    const file = this.publicationKey(info.ino), mtime = intent.truncate ? Date.now() : info.mtime;
    const changes: PublicationEffect[] = [];
    if (size !== info.size) changes.push({ kind: "resize", file, size, version: this.shared.publication!.nextContentVersion(info.ino) });
    if (mtime !== info.mtime) changes.push({ kind: "metadata", file, mode: info.mode ?? 0o600, mtime });
    return { action: { kind: "resize", handle: intent.handle, size: intent.size, truncate: intent.truncate, mtime }, result: { kind: "number", value: 0 }, changes };
  }
  private planPublicationMode(intent: Extract<MutationIntent, { kind: "setMode" }>): LocalMutationPlan {
    this.check(intent.handle);
    const supported = this.fs.permissions(intent.handle).modeSupported;
    if (intent.mode > 0xffffffff) return { action: { kind: "none" }, result: { kind: "number", value: 28 }, changes: [] };
    if (intent.mode & ~supported) return { action: { kind: "none" }, result: { kind: "number", value: 58 }, changes: [] };
    const stat = this.shared.stat(intent.handle)!;
    const changes: PublicationEffect[] = stat.mode === intent.mode ? [] : [{ kind: "metadata", file: this.publicationKey(stat.ino), mode: intent.mode, mtime: stat.mtime }];
    return { action: { kind: "setMode", handle: intent.handle, mode: intent.mode }, result: { kind: "number", value: 0 }, changes };
  }
  private planPublicationMtime(intent: Extract<MutationIntent, { kind: "setMtime" }>): LocalMutationPlan {
    this.check(intent.handle);
    if (!(this.fs.permissions(intent.handle).access & 2)) throw new FilesystemError(2);
    const stat = this.shared.stat(intent.handle)!;
    const changes: PublicationEffect[] = stat.mtime === intent.mtime ? [] : [{ kind: "metadata", file: this.publicationKey(stat.ino), mode: stat.mode ?? 0o600, mtime: intent.mtime }];
    return { action: { kind: "setMtime", handle: intent.handle, mtime: intent.mtime }, result: { kind: "number", value: 0 }, changes };
  }
  /** Only this synchronous typed switch applies a publication-aware service mutation. */
  applyPublication(plan: LocalMutationPlan): void {
    const action = plan.action;
    switch (action.kind) {
      case "none": return;
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
      case "preopen": this.sync(this.fs.preopen(action.path)); return;
      case "namespace": this.applyNamespace(action); return;
      case "writeFile":
        this.applyNamespace(action.namespace);
        if (!action.append) this.shared.resize(action.handle, 0, true);
        if (action.data.length) this.shared.write(action.handle, [action.data], action.offset);
        this.shared.setMtime(action.handle, action.mtime);
        this.fs.setMtime(action.handle, action.mtime);
        if (!action.append) this.shared.reclaimLocked(action.handle);
        return;
      default: { const exhaustive: never = action; return exhaustive; }
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
    return this.shared.resources();
  }
}
