import { permissionsFor, FilesystemError } from "../core/filesystem.js";
import {
  normalize,
  splitPath,
  dirname,
  basename,
  type FileSystem,
  type FileHandle,
  type FileStat,
  type DirectoryEntry,
  type ResolvedPath,
} from "../core/index.js";

export { normalize, splitPath, dirname, basename } from "../core/index.js";

// In-memory filesystem shared by the shell, the editor and every bun.wasm run.
// The browser filesystem service is the sole owner of this tree.

export interface FileNode {
  kind: "file";
  data: Uint8Array;
  /** Logical size when the persistence backend keeps the payload outside this object. */
  size?: number;
  mode: number;
  mtime: number; // ms since epoch
  ino: number;
}

export interface DirNode {
  kind: "dir";
  children: Map<string, Node>;
  mode: number;
  mtime: number;
  ino: number;
}

export type Node = FileNode | DirNode;

export interface NamespaceEdge {
  readonly parent: DirNode;
  readonly name: string;
  readonly before: Node | undefined;
  readonly after: Node | undefined;
}
export interface NamespacePlan {
  readonly edits: readonly NamespaceEdge[];
  readonly edges: readonly NamespaceEdge[];
  readonly created: readonly Node[];
  readonly parents: readonly DirNode[];
  readonly forgotten: readonly Node[];
  readonly links: readonly { readonly node: Node; readonly delta: 1 | -1 }[];
  readonly mtime: number;
}
function namespacePlan(edits: readonly NamespaceEdge[] = [], created: readonly Node[] = [], forgotten: readonly Node[] = [], links: NamespacePlan["links"] = []): NamespacePlan {
  return { edits, edges: edits, created, forgotten, links, parents: Array.from(new Set(edits.map((edge) => edge.parent))), mtime: Date.now() };
}
function boundedNamespace(plan: NamespacePlan, bound: number): NamespacePlan {
  if (plan.edges.length + plan.created.length + plan.parents.length > bound) throw new FilesystemError(6, "namespace effect bound exceeded");
  return plan;
}

let nextIno = 1;

export function newIno(): number {
  return nextIno++;
}

/** Explicit fixture trees may supply inode numbers; keep the sole allocator ahead of them. */
export function adoptInodes(root: DirNode): void {
  let max = 0;
  const walk = (node: Node) => {
    if (node.ino > max) max = node.ino;
    if (node.kind === "dir") for (const child of node.children.values()) walk(child);
  };
  walk(root);
  if (max >= nextIno) nextIno = max + 1;
}

export function newDir(): DirNode {
  return { kind: "dir", mode: 0o700, children: new Map(), mtime: Date.now(), ino: newIno() };
}

export function newFile(data: Uint8Array = new Uint8Array(0)): FileNode {
  return { kind: "file", mode: 0o600, data, mtime: Date.now(), ino: newIno() };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decode(data: Uint8Array): string {
  // TextDecoder rejects resizable backing; shared input also needs a private snapshot.
  return decoder.decode(
    Reflect.get(data.buffer, "resizable") ||
      Object.prototype.toString.call(data.buffer) === "[object SharedArrayBuffer]"
      ? new Uint8Array(data)
      : data,
  );
}

export class MemFS implements FileSystem {
  onChange?: (node: Node) => void;
  /** Namespace edge changes; moving an existing edge leaves its count unchanged. */
  onLinkChange?: (node: Node, delta: 1 | -1) => void;
  private changed(node: Node): void {
    this.onChange?.(node);
  }
  // Handles belong to this filesystem, not to the WASI adapter. Node identity survives unlink.
  private handles = new Map<FileHandle, Node>();
  private nodeHandles = new WeakMap<Node, FileHandle>();
  private nextHandle = 0;
  private references = new Map<FileHandle, number>();
  private directoryParents = new WeakMap<DirNode, DirNode>();
  private removedDirectories = new WeakSet<DirNode>();
  private pathDirs: DirNode[] = [];

  private handle(node: Node): FileHandle {
    // Capability identity follows the object, independently of names and links.
    let handle = this.nodeHandles.get(node);
    if (handle === undefined) {
      handle = this.nextHandle++;
      this.nodeHandles.set(node, handle);
    }
    this.handles.set(handle, node);
    return handle;
  }
  retain(handle: FileHandle): void {
    this.nodeForHandle(handle);
    this.references.set(handle, (this.references.get(handle) ?? 0) + 1);
  }
  release(handle: FileHandle): void {
    const count = this.references.get(handle);
    if (!count) throw new Error("filesystem handle has no references");
    if (count > 1) this.references.set(handle, count - 1);
    else {
      this.references.delete(handle);
      this.handles.delete(handle);
    }
  }
  private forget(node: Node): void {
    const handle = this.nodeHandles.get(node);
    if (handle !== undefined && !this.references.has(handle)) this.handles.delete(handle);
    if (node.kind === "dir") {
      this.removedDirectories.add(node);
      for (const child of node.children.values()) this.forget(child);
      // Recursive removal removes directory entries, not the bytes of separately open files.
      node.children.clear();
    }
  }
  nodeForHandle(handle: FileHandle): Node {
    const node = this.handles.get(handle);
    if (!node) throw new Error(`unknown filesystem handle ${handle}`);
    return node;
  }
  handleForNode(node: Node): FileHandle {
    return this.handle(node);
  }

  private directory(handle: FileHandle): DirNode {
    const node = this.nodeForHandle(handle);
    if (node.kind !== "dir") throw new Error("not a directory handle");
    return node;
  }
  private directoryParent(node: DirNode, root = this.root): DirNode | undefined {
    if (root === node) return root;
    for (const child of root.children.values()) {
      if (child === node) return root;
      if (child.kind === "dir") {
        const parent = this.directoryParent(node, child);
        if (parent) return parent;
      }
    }
    return undefined;
  }
  private containsDirectory(root: DirNode, node: DirNode): boolean {
    if (root === node) return true;
    for (const child of root.children.values()) {
      if (child.kind === "dir" && this.containsDirectory(child, node)) return true;
    }
    return false;
  }
  preopen(path: string): FileHandle {
    const node = this.mkdirp(path);
    this.directoryParents.set(node, this.directoryParent(node) ?? node);
    return this.handle(node);
  }
  resolve(directory: FileHandle, path: string): ResolvedPath | number {
    if (path.startsWith("/")) return 63;
    return this.walk(directory, path, false);
  }
  /** Page paths are absolute: parent-of-root stays at root, unlike WASI capabilities. */
  resolveAbsolute(path: string): ResolvedPath | number {
    if (!path.startsWith("/")) return 28;
    return this.walk(this.handle(this.root), path.replace(/^\/+/, "") || ".", true);
  }
  private walk(directory: FileHandle, path: string, clampRoot: boolean): ResolvedPath | number {
    if (path.length === 0) return 44;
    const dirs = this.pathDirs;
    dirs.length = 0;
    let node: Node = this.directory(directory);
    let parent: DirNode | undefined;
    let name = "";
    let terminalDot = false;
    // Keep the actual-tree fast path: no lexical cancellation of missing/.. or file/...
    for (let start = 0; start < path.length;) {
      let end = path.indexOf("/", start);
      if (end < 0) end = path.length;
      const part = path.slice(start, end);
      start = end + 1;
      if (part === "") continue;
      terminalDot = part === "." || part === "..";
      if (node.kind !== "dir") return 54;
      if (!(node.mode & 0o100)) return 2;
      if (part === ".") continue;
      if (part === "..") {
        if (dirs.length === 0) {
          if (!clampRoot) return 63;
        } else node = dirs.pop()!;
        parent = undefined;
        name = "";
        continue;
      }
      parent = node;
      name = part;
      const child = parent.children.get(part);
      if (!child) {
        for (let i = start; i < path.length; i++) if (path.charCodeAt(i) !== 47) return 44;
        return {
          parent: this.handle(parent),
          name,
          node: undefined,
          trailingSlash: path.endsWith("/"),
          terminalDot: false,
        };
      }
      dirs.push(parent);
      if (child.kind === "dir") this.directoryParents.set(child, parent);
      node = child;
    }
    const trailingSlash = path.endsWith("/");
    if (trailingSlash && node.kind !== "dir") return 54;
    return {
      parent: parent ? this.handle(parent) : undefined,
      name,
      node: this.handle(node),
      trailingSlash,
      terminalDot,
    };
  }
  stat(handle: FileHandle): FileStat {
    const node = this.nodeForHandle(handle);
    return {
      kind: node.kind === "dir" ? "directory" : "file",
      ino: node.ino,
      size: node.kind === "file" ? (node.size ?? node.data.length) : 0,
      mtime: node.mtime,
      mode: node.mode,
    };
  }
  permissions(handle: FileHandle) {
    const node = this.nodeForHandle(handle);
    return permissionsFor(node.kind === "dir" ? "directory" : "file", node.mode);
  }
  /** Host policy mutation. All inodes belong to the same virtual principal. */
  setMode(handle: FileHandle, mode: number): number {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0xffffffff) return 28;
    const node = this.nodeForHandle(handle);
    if (mode & ~this.permissions(handle).modeSupported) return 58;
    node.mode = mode;
    this.changed(node);
    return 0;
  }
  private require(node: Node, access: number): void {
    if (((node.mode >>> 6) & access) !== access) throw new FilesystemError(2);
  }
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    const node = this.nodeForHandle(handle) as FileNode;
    if (!(node.mode & 0o400)) return -2;
    let pos = offset;
    for (const chunk of chunks) {
      const n = Math.max(0, Math.min(chunk.length, node.data.length - pos));
      chunk.set(node.data.subarray(pos, pos + n));
      pos += n;
      if (n < chunk.length) break;
    }
    return pos - offset;
  }
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    const node = this.nodeForHandle(handle) as FileNode;
    if (!(node.mode & 0o200)) return -2;
    if (chunks.every((chunk) => chunk.length === 0)) return 0;
    let pos = offset;
    for (const chunk of chunks) {
      ensureSize(node, pos + chunk.length);
      node.data.set(chunk, pos);
      pos += chunk.length;
    }
    node.mtime = Date.now();
    return pos - offset;
  }
  append(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
  ): { written: number; offset: number } | number {
    const offset = (this.nodeForHandle(handle) as FileNode).data.length;
    const written = this.write(handle, chunks, offset);
    return written < 0 ? written : { written, offset: offset + written };
  }
  resize(handle: FileHandle, size: number, truncate: boolean): number {
    const node = this.nodeForHandle(handle) as FileNode;
    if (!(node.mode & 0o200)) return 2;
    if (truncate && size < node.data.length) node.data = node.data.slice(0, size);
    else ensureSize(node, size);
    if (truncate) node.mtime = Date.now();
    return 0;
  }
  setMtime(handle: FileHandle, mtime: number): number {
    const node = this.nodeForHandle(handle);
    if (!(node.mode & 0o200)) return 2;
    node.mtime = mtime;
    this.changed(node);
    return 0;
  }
  readdir(handle: FileHandle): DirectoryEntry[] {
    const node = this.directory(handle);
    this.require(node, 4);
    const parent = this.directoryParents.get(node) ?? node;
    const entry = (name: string, node: Node): DirectoryEntry => ({
      name,
      ino: node.ino,
      kind: node.kind === "dir" ? "directory" : "file",
    });
    const list = [entry(".", node), entry("..", parent)];
    // One list per call, not one list per entry or cookie. No file buffers cross the boundary.
    for (const [name, child] of node.children) list.push(entry(name, child));
    return list;
  }
  private parentOf(path: ResolvedPath): DirNode | number {
    if (path.parent === undefined) return 63;
    const parent = this.directory(path.parent);
    if (this.removedDirectories.has(parent)) return 44;
    return (parent.mode & 0o300) === 0o300 ? parent : 2;
  }
  create(
    path: ResolvedPath,
    kind: "file" | "directory",
    exclusive = true,
  ): FileHandle | { error: number } {
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { error: parent };
    const existing = parent.children.get(path.name);
    if (existing) return !exclusive && kind === "file" ? this.handle(existing) : { error: 20 };
    const node = kind === "file" ? newFile() : newDir();
    parent.children.set(path.name, node);
    this.onLinkChange?.(node, 1);
    parent.mtime = Date.now();
    this.changed(node);
    this.changed(parent);
    if (node.kind === "dir") this.directoryParents.set(node, parent);
    return this.handle(node);
  }
  link(from: ResolvedPath, to: ResolvedPath): number {
    if (from.node === undefined) return 44;
    const node = this.nodeForHandle(from.node);
    if (node.kind === "dir") return 63;
    if (to.node !== undefined) return 20;
    if (to.trailingSlash) return 54;
    const parent = this.parentOf(to);
    if (typeof parent === "number") return parent;
    parent.children.set(to.name, node);
    this.onLinkChange?.(node, 1);
    parent.mtime = Date.now();
    this.changed(parent);
    return 0;
  }
  removePath(path: ResolvedPath, directory: boolean): number {
    if (directory && path.terminalDot) return 28;
    if (path.node === undefined) return 44;
    const node = this.nodeForHandle(path.node);
    if (directory && node.kind !== "dir") return 54;
    if (!directory && node.kind === "dir") return 31;
    if (node.kind === "dir" && node.children.size > 0) return 55;
    if (path.parent === undefined) return 63;
    const parent = this.directory(path.parent);
    if ((parent.mode & 0o300) !== 0o300) return 2;
    parent.children.delete(path.name);
    this.onLinkChange?.(node, -1);
    parent.mtime = Date.now();
    this.changed(parent);
    this.forget(node);
    if (node.kind === "dir") this.removedDirectories.add(node);
    return 0;
  }
  rename(from: ResolvedPath, to: ResolvedPath): number {
    if (from.terminalDot || to.terminalDot) return 28;
    if (from.node === undefined) return 44;
    const node = this.nodeForHandle(from.node);
    const target = to.node === undefined ? undefined : this.nodeForHandle(to.node);
    if (node === target) return 0;
    if (to.trailingSlash && node.kind !== "dir") return 54;
    if (
      node.kind === "dir" &&
      to.parent !== undefined &&
      this.containsDirectory(node, this.directory(to.parent))
    )
      return 28;
    if (target?.kind === "dir" && node.kind !== "dir") return 31;
    if (target && target.kind !== "dir" && node.kind === "dir") return 54;
    if (target?.kind === "dir" && target.children.size > 0) return 55;
    const parent = this.parentOf(to);
    if (typeof parent === "number") return parent;
    if (from.parent === undefined) return 63;
    const sourceParent = this.directory(from.parent);
    if ((sourceParent.mode & 0o300) !== 0o300) return 2;
    sourceParent.children.delete(from.name);
    sourceParent.mtime = Date.now();
    parent.children.set(to.name, node);
    if (node.kind === "dir") this.directoryParents.set(node, parent);
    if (target) {
      this.forget(target);
      this.onLinkChange?.(target, -1);
    }
    if (target?.kind === "dir") this.removedDirectories.add(target);
    parent.mtime = Date.now();
    this.changed(sourceParent);
    this.changed(parent);
    return 0;
  }

  /** Plans refer to the actual nodes and edges. No mirror tree is built or mutated. */
  planCreate(path: ResolvedPath, kind: "file" | "directory", exclusive: boolean, bound: number): { readonly plan: NamespacePlan; readonly result: FileHandle | { error: number } } {
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { plan: namespacePlan(), result: { error: parent } };
    const existing = parent.children.get(path.name);
    if (existing) return { plan: namespacePlan(), result: !exclusive && kind === "file" ? this.handle(existing) : { error: 20 } };
    const node = kind === "file" ? newFile() : newDir();
    const plan = boundedNamespace(namespacePlan([{ parent, name: path.name, before: undefined, after: node }], [node], [], [{ node, delta: 1 }]), bound);
    return { plan, result: this.handle(node) };
  }
  planLink(from: ResolvedPath, to: ResolvedPath, bound: number): { readonly plan: NamespacePlan; readonly result: number } {
    if (from.node === undefined) return { plan: namespacePlan(), result: 44 };
    const node = this.nodeForHandle(from.node);
    if (node.kind === "dir") return { plan: namespacePlan(), result: 63 };
    if (to.node !== undefined) return { plan: namespacePlan(), result: 20 };
    if (to.trailingSlash) return { plan: namespacePlan(), result: 54 };
    const parent = this.parentOf(to);
    if (typeof parent === "number") return { plan: namespacePlan(), result: parent };
    return { plan: boundedNamespace(namespacePlan([{ parent, name: to.name, before: undefined, after: node }], [], [], [{ node, delta: 1 }]), bound), result: 0 };
  }
  planRemovePath(path: ResolvedPath, directory: boolean, bound: number): { readonly plan: NamespacePlan; readonly result: number } {
    if (directory && path.terminalDot) return { plan: namespacePlan(), result: 28 };
    if (path.node === undefined) return { plan: namespacePlan(), result: 44 };
    const node = this.nodeForHandle(path.node);
    if (directory && node.kind !== "dir") return { plan: namespacePlan(), result: 54 };
    if (!directory && node.kind === "dir") return { plan: namespacePlan(), result: 31 };
    if (node.kind === "dir" && node.children.size) return { plan: namespacePlan(), result: 55 };
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { plan: namespacePlan(), result: parent };
    return { plan: boundedNamespace(namespacePlan([{ parent, name: path.name, before: node, after: undefined }], [], [node], [{ node, delta: -1 }]), bound), result: 0 };
  }
  planRename(from: ResolvedPath, to: ResolvedPath, bound: number): { readonly plan: NamespacePlan; readonly result: number } {
    const failure = (result: number) => ({ plan: namespacePlan(), result });
    if (from.terminalDot || to.terminalDot) return failure(28);
    if (from.node === undefined) return failure(44);
    const node = this.nodeForHandle(from.node);
    const target = to.node === undefined ? undefined : this.nodeForHandle(to.node);
    if (node === target) return failure(0);
    if (to.trailingSlash && node.kind !== "dir") return failure(54);
    if (node.kind === "dir" && to.parent !== undefined && this.containsDirectory(node, this.directory(to.parent))) return failure(28);
    if (target?.kind === "dir" && node.kind !== "dir") return failure(31);
    if (target && target.kind !== "dir" && node.kind === "dir") return failure(54);
    if (target?.kind === "dir" && target.children.size) return failure(55);
    const parent = this.parentOf(to), source = this.parentOf(from);
    if (typeof parent === "number") return failure(parent);
    if (typeof source === "number") return failure(source);
    const edges = [{ parent: source, name: from.name, before: node, after: undefined }, { parent, name: to.name, before: target, after: node }];
    return { plan: boundedNamespace(namespacePlan(edges, [], target ? [target] : [], target ? [{ node: target, delta: -1 }] : []), bound), result: 0 };
  }
  planMkdirp(path: string, bound: number): { readonly plan: NamespacePlan; readonly node: DirNode } {
    let node = this.root;
    const edges: NamespaceEdge[] = [], created: Node[] = [];
    for (const part of splitPath(path)) {
      this.require(node, 1);
      let child = node.children.get(part);
      if (!child) child = this.planDirectoryChild(node, part, edges, created, bound);
      if (child.kind !== "dir") throw new FilesystemError(54);
      node = child;
    }
    const plan = boundedNamespace(namespacePlan(edges, created, [], created.map((entry) => ({ node: entry, delta: 1 }))), bound);
    return { plan, node };
  }
  private planDirectoryChild(parent: DirNode, name: string, edges: NamespaceEdge[], created: Node[], bound: number): DirNode {
    this.require(parent, 2);
    if (edges.length * 3 + 3 > bound) throw new FilesystemError(6, "namespace effect bound exceeded");
    const child = newDir();
    edges.push({ parent, name, before: undefined, after: child });
    created.push(child);
    return child;
  }
  planRemove(path: string, bound: number): { readonly plan: NamespacePlan; readonly result: boolean } {
    const parent = this.lookup(dirname(path));
    if (parent?.kind !== "dir") return { plan: namespacePlan(), result: false };
    this.require(parent, 3);
    const name = basename(path), node = parent.children.get(name);
    if (!node) return { plan: namespacePlan(), result: false };
    const plan = namespacePlan([{ parent, name, before: node, after: undefined }], [], [node], [{ node, delta: -1 }]);
    const edges = plan.edges.slice();
    const pending: Node[] = [node];
    while (pending.length) this.collectRemovalEdges(pending.pop()!, pending, edges, bound);
    return { plan: boundedNamespace({ ...plan, edges }, bound), result: true };
  }
  private collectRemovalEdges(node: Node, pending: Node[], edges: NamespaceEdge[], bound: number): void {
    if (node.kind !== "dir") return;
    for (const [name, child] of node.children) {
      if (edges.length + 2 > bound) throw new FilesystemError(6, "namespace effect bound exceeded");
      edges.push({ parent: node, name, before: child, after: undefined });
      pending.push(child);
    }
  }
  /** The sole publication namespace apply point. Persistence callbacks stay on actual edits. */
  applyNamespace(plan: NamespacePlan): void {
    const created = new Set(plan.created);
    for (const edge of plan.edits) {
      if (edge.after) edge.parent.children.set(edge.name, edge.after);
      else edge.parent.children.delete(edge.name);
      if (edge.after?.kind === "dir") this.directoryParents.set(edge.after, edge.parent);
      if (edge.after && created.has(edge.after)) this.onLinkChange?.(edge.after, 1);
    }
    for (const link of plan.links) {
      if (created.has(link.node)) continue;
      this.onLinkChange?.(link.node, link.delta);
    }
    for (const node of plan.forgotten) this.forget(node);
    for (const node of plan.created) { node.mtime = plan.mtime; this.changed(node); }
    for (const parent of plan.parents) { parent.mtime = plan.mtime; this.changed(parent); }
  }
  discardNamespace(plan: NamespacePlan): void {
    for (const node of plan.created) this.forget(node);
  }

  constructor(public root: DirNode = newDir()) {
    adoptInodes(root);
  }

  hasNode(target: Node): boolean {
    const walk = (node: Node): boolean =>
      node === target ||
      (node.kind === "dir" && Array.from(node.children.values()).some((child) => walk(child)));
    return walk(this.root);
  }

  lookup(path: string): Node | undefined {
    let node: Node = this.root;
    for (const part of splitPath(path)) {
      if (node.kind !== "dir") return undefined;
      this.require(node, 1);
      const child = node.children.get(part);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  mkdirp(path: string): DirNode {
    let node: DirNode = this.root;
    for (const part of splitPath(path)) {
      this.require(node, 1);
      let child = node.children.get(part);
      if (!child) {
        this.require(node, 2);
        child = newDir();
        node.children.set(part, child);
        this.onLinkChange?.(child, 1);
        node.mtime = Date.now();
        this.changed(child);
        this.changed(node);
      }
      if (child.kind !== "dir") throw new Error(`${part}: not a directory`);
      node = child;
    }
    return node;
  }

  writeFile(path: string, content: string | Uint8Array, append = false): void {
    const data = typeof content === "string" ? encode(content) : content;
    const parent = this.mkdirp(dirname(path));
    this.require(parent, 1);
    const name = basename(path);
    const existing = parent.children.get(name);
    if (existing) this.require(existing, 2);
    else this.require(parent, 3);
    if (existing?.kind === "dir") throw new Error(`${name}: is a directory`);
    if (existing && append) {
      const merged = new Uint8Array(existing.data.length + data.length);
      merged.set(existing.data);
      merged.set(data, existing.data.length);
      existing.data = merged;
      existing.mtime = Date.now();
      this.changed(existing);
      return;
    }
    if (existing) {
      existing.data = data;
      existing.mtime = Date.now();
      this.changed(existing);
      return;
    }
    const file = newFile(data);
    parent.children.set(name, file);
    this.onLinkChange?.(file, 1);
    parent.mtime = Date.now();
    this.changed(file);
    this.changed(parent);
  }

  readFile(path: string): Uint8Array | undefined {
    const node = this.lookup(path);
    if (node?.kind !== "file") return undefined;
    this.require(node, 4);
    return node.data;
  }

  remove(path: string): boolean {
    const parent = this.lookup(dirname(path));
    if (parent?.kind !== "dir") return false;
    this.require(parent, 3);
    const node = parent.children.get(basename(path));
    const removed = parent.children.delete(basename(path));
    if (removed) {
      this.onLinkChange?.(node!, -1);
      this.forget(node!);
      parent.mtime = Date.now();
      this.changed(parent);
    }
    return removed;
  }

  /** Every regular file under `dir`, as absolute paths, sorted. */
  listFiles(dir = "/"): string[] {
    const out: string[] = [];
    const walk = (node: Node, path: string) => {
      if (node.kind === "file") {
        out.push(path);
        return;
      }
      this.require(node, 5);
      for (const [name, child] of node.children)
        walk(child, path === "/" ? `/${name}` : `${path}/${name}`);
    };
    const start = this.lookup(dir);
    if (start) walk(start, normalize(dir));
    return out.sort();
  }
}

/** Grow a file's buffer geometrically so many small writes stay linear. */
function ensureSize(node: FileNode, size: number): void {
  if (size <= node.data.length) return;
  const buffer = node.data.buffer as ArrayBuffer;
  if (node.data.byteOffset === 0 && buffer.byteLength >= size) {
    node.data = new Uint8Array(buffer, 0, size);
    return;
  }
  const grown = new Uint8Array(Math.max(size, node.data.length * 2, 64));
  grown.set(node.data);
  node.data = grown.subarray(0, size);
}
