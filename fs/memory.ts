import type { FileIdentity } from "./file-identity.js";
import type { NodeMetadata } from "./workspace-types.js";
import { permissionsFor, FilesystemError } from "../core/filesystem.js";
import {
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
  identity?: FileIdentity;
  kind: "file";
  data: Uint8Array;
  /** Logical size when the persistence backend keeps the payload outside this object. */
  size?: number;
  mode: number;
  mtime: number; // ms since epoch
  ino: number;
}

export interface DirNode {
  identity?: FileIdentity;
  kind: "dir";
  children: Map<string, Node>;
  mode: number;
  mtime: number;
  ino: number;
}

export interface SymlinkNode {
  identity?: FileIdentity;
  kind: "symlink";
  readonly target: string;
  mode: number;
  mtime: number;
  ino: number;
}
export type Node = FileNode | DirNode | SymlinkNode;

export function newSymlink(target: string): SymlinkNode {
  return { kind: "symlink", target, mode: 0o600, mtime: Date.now(), ino: newIno() };
}
export function nodeKind(node: Node): FileStat["kind"] {
  return node.kind === "dir" ? "directory" : node.kind;
}
export function nodeMetadata(node: Node): NodeMetadata {
  if (node.kind === "symlink") return { kind: "symlink", target: node.target };
  return { kind: node.kind === "dir" ? "directory" : "file" };
}
export function nodeSize(node: Node): number {
  if (node.kind === "symlink") return encode(node.target).length;
  return node.kind === "file" ? (node.size ?? node.data.length) : 0;
}
interface MemoryPath extends ResolvedPath {
  readonly canonicalPath: string;
}
interface TreePath {
  canonicalPath: string;
  parent: DirNode | undefined;
  node: Node | undefined;
  name: string;
  trailingSlash: boolean;
  terminalDot: boolean;
}
interface TreeWalk {
  followFinal?: boolean;
  clampRoot: boolean;
  child?: (parent: DirNode, name: string) => Node | undefined;
  search?: (node: DirNode) => void;
  depth?: number;
  pathUnits?: number;
}
function treePathError(path: string, limit: number | undefined): number {
  if (!path) return 44;
  if (path.includes("\0")) return 28;
  return limit !== undefined && path.length > limit ? 37 : 0;
}
function expandTreeLink(
  child: Node,
  path: string,
  start: number,
  options: TreeWalk,
  expansions: number,
): { readonly path: string; readonly absolute: boolean } | number | undefined {
  if (child.kind !== "symlink") return;
  if (!options.followFinal && start >= path.length && !path.endsWith("/")) return;
  if (expansions >= 40) return 32;
  const target = child.target;
  if (!target) return 44;
  const absolute = target.startsWith("/");
  if (absolute && !options.clampRoot) return 63;
  const suffix = path.slice(start);
  const expanded = target + (suffix || path.endsWith("/") ? "/" + suffix : "");
  const error = treePathError(expanded, options.pathUnits);
  return error || { path: expanded, absolute };
}
/** Expand links against actual parent edges, never a lexically normalized pathname. */
export function walkTree(root: DirNode, path: string, options: TreeWalk): TreePath | number {
  const error = treePathError(path, options.pathUnits);
  if (error) return error;
  const dirs: DirNode[] = [];
  const names: string[] = [];
  let node: Node = root;
  let parent: DirNode | undefined;
  let name = "",
    terminalDot = false,
    expansions = 0,
    start = 0;
  while (start < path.length) {
    let end = path.indexOf("/", start);
    if (end < 0) end = path.length;
    const part = path.slice(start, end);
    start = end + 1;
    if (!part) continue;
    if (node.kind !== "dir") return 54;
    if (options.search) options.search(node);
    else if (!(node.mode & 0o100)) return 2;
    terminalDot = part === "." || part === "..";
    if (part === ".") continue;
    if (part === ".." && !dirs.length && !options.clampRoot) return 63;
    if (part === "..") {
      node = dirs.pop() ?? root;
      names.pop();
      parent = undefined;
      name = "";
      continue;
    }
    parent = node;
    name = part;
    const child: Node | undefined = options.child
      ? options.child(parent, part)
      : parent.children.get(part);
    if (!child && /[^/]/.test(path.slice(start))) return 44;
    if (!child)
      return {
        canonicalPath: "/" + names.concat(part).join("/"),
        parent,
        name,
        node: undefined,
        trailingSlash: path.endsWith("/"),
        terminalDot: false,
      };
    const link = expandTreeLink(child, path, start, options, expansions);
    if (typeof link === "number") return link;
    if (link?.absolute) {
      dirs.length = 0;
      names.length = 0;
    }
    if (link) {
      expansions++;
      node = link.absolute ? root : node;
      path = link.path;
      start = 0;
      continue;
    }
    if (options.depth !== undefined && dirs.length >= options.depth) return 6;
    dirs.push(parent);
    names.push(part);
    node = child;
  }
  const trailingSlash = path.endsWith("/");
  if (trailingSlash && node.kind !== "dir") return 54;
  return { parent, name, node, trailingSlash, terminalDot, canonicalPath: "/" + names.join("/") };
}

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
function namespacePlan(
  edits: readonly NamespaceEdge[] = [],
  created: readonly Node[] = [],
  forgotten: readonly Node[] = [],
  links: NamespacePlan["links"] = [],
): NamespacePlan {
  return {
    edits,
    edges: edits,
    created,
    forgotten,
    links,
    parents: Array.from(new Set(edits.map((edge) => edge.parent))),
    mtime: Date.now(),
  };
}
function boundedNamespace(plan: NamespacePlan, bound: number): NamespacePlan {
  if (plan.edges.length + plan.created.length + plan.parents.length > bound)
    throw new FilesystemError(6, "namespace effect bound exceeded");
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

  existingHandle(node: Node): FileHandle | undefined {
    return this.nodeHandles.get(node);
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
  resolve(directory: FileHandle, path: string, followFinal = false): ResolvedPath | number {
    if (path.startsWith("/")) return 63;
    const resolved = this.walk(directory, path, false, followFinal);
    if (typeof resolved === "number") return resolved;
    return {
      name: resolved.name,
      trailingSlash: resolved.trailingSlash,
      terminalDot: resolved.terminalDot,
      parent: resolved.parent,
      node: resolved.node,
    };
  }
  /** Page paths clamp parent-of-root, unlike WASI directory capabilities. */
  resolveAbsolute(path: string, followFinal = false): MemoryPath | number {
    if (!path.startsWith("/")) return 28;
    return this.walk(this.handle(this.root), path.replace(/^\/+/, "") || ".", true, followFinal);
  }
  private walk(
    directory: FileHandle,
    path: string,
    clampRoot: boolean,
    followFinal: boolean,
  ): MemoryPath | number {
    const resolved = walkTree(this.directory(directory), path, {
      clampRoot,
      followFinal,
      child: (parent, name) => {
        const child = parent.children.get(name);
        if (child?.kind === "dir") this.directoryParents.set(child, parent);
        return child;
      },
    });
    if (typeof resolved === "number") return resolved;
    return {
      canonicalPath: resolved.canonicalPath,
      name: resolved.name,
      trailingSlash: resolved.trailingSlash,
      terminalDot: resolved.terminalDot,
      parent: resolved.parent ? this.handle(resolved.parent) : undefined,
      node: resolved.node ? this.handle(resolved.node) : undefined,
    };
  }
  symlink(path: ResolvedPath, target: string): number {
    const prepared = this.planSymlink(path, target, 4);
    this.applyNamespace(prepared.plan);
    return prepared.result;
  }
  readlink(handle: FileHandle): string {
    const node = this.nodeForHandle(handle);
    if (node.kind !== "symlink") throw new FilesystemError(28);
    return node.target;
  }
  planSymlink(
    path: ResolvedPath,
    target: string,
    bound: number,
  ): { plan: NamespacePlan; result: number } {
    if (!target || target.includes("\0"))
      return { plan: namespacePlan(), result: target ? 28 : 44 };
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { plan: namespacePlan(), result: parent };
    if (parent.children.has(path.name)) return { plan: namespacePlan(), result: 20 };
    if (path.trailingSlash) return { plan: namespacePlan(), result: 54 };
    const node = newSymlink(target);
    const plan = namespacePlan(
      [{ parent, name: path.name, before: undefined, after: node }],
      [node],
      [],
      [{ node, delta: 1 }],
    );
    return { plan: boundedNamespace(plan, bound), result: 0 };
  }
  stat(handle: FileHandle): FileStat {
    const node = this.nodeForHandle(handle);
    return {
      kind: nodeKind(node),
      ino: node.ino,
      size: nodeSize(node),
      mtime: node.mtime,
      mode: node.mode,
    };
  }
  permissions(handle: FileHandle) {
    const node = this.nodeForHandle(handle);
    return permissionsFor(nodeKind(node), node.mode);
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
      kind: nodeKind(node),
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
  planCreate(
    path: ResolvedPath,
    kind: "file" | "directory",
    exclusive: boolean,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly result: FileHandle | { error: number } } {
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { plan: namespacePlan(), result: { error: parent } };
    const existing = parent.children.get(path.name);
    if (existing)
      return {
        plan: namespacePlan(),
        result: !exclusive && kind === "file" ? this.handle(existing) : { error: 20 },
      };
    const node = kind === "file" ? newFile() : newDir();
    const plan = boundedNamespace(
      namespacePlan(
        [{ parent, name: path.name, before: undefined, after: node }],
        [node],
        [],
        [{ node, delta: 1 }],
      ),
      bound,
    );
    return { plan, result: this.handle(node) };
  }
  planLink(
    from: ResolvedPath,
    to: ResolvedPath,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly result: number } {
    if (from.node === undefined) return { plan: namespacePlan(), result: 44 };
    const node = this.nodeForHandle(from.node);
    if (node.kind === "dir") return { plan: namespacePlan(), result: 63 };
    if (to.node !== undefined) return { plan: namespacePlan(), result: 20 };
    if (to.trailingSlash) return { plan: namespacePlan(), result: 54 };
    const parent = this.parentOf(to);
    if (typeof parent === "number") return { plan: namespacePlan(), result: parent };
    return {
      plan: boundedNamespace(
        namespacePlan(
          [{ parent, name: to.name, before: undefined, after: node }],
          [],
          [],
          [{ node, delta: 1 }],
        ),
        bound,
      ),
      result: 0,
    };
  }
  planRemovePath(
    path: ResolvedPath,
    directory: boolean,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly result: number } {
    if (directory && path.terminalDot) return { plan: namespacePlan(), result: 28 };
    if (path.node === undefined) return { plan: namespacePlan(), result: 44 };
    const node = this.nodeForHandle(path.node);
    if (directory && node.kind !== "dir") return { plan: namespacePlan(), result: 54 };
    if (!directory && node.kind === "dir") return { plan: namespacePlan(), result: 31 };
    if (node.kind === "dir" && node.children.size) return { plan: namespacePlan(), result: 55 };
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { plan: namespacePlan(), result: parent };
    return {
      plan: boundedNamespace(
        namespacePlan(
          [{ parent, name: path.name, before: node, after: undefined }],
          [],
          [node],
          [{ node, delta: -1 }],
        ),
        bound,
      ),
      result: 0,
    };
  }
  planRename(
    from: ResolvedPath,
    to: ResolvedPath,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly result: number } {
    const failure = (result: number) => ({ plan: namespacePlan(), result });
    if (from.terminalDot || to.terminalDot) return failure(28);
    if (from.node === undefined) return failure(44);
    const node = this.nodeForHandle(from.node);
    const target = to.node === undefined ? undefined : this.nodeForHandle(to.node);
    if (node === target) return failure(0);
    if (to.trailingSlash && node.kind !== "dir") return failure(54);
    if (
      node.kind === "dir" &&
      to.parent !== undefined &&
      this.containsDirectory(node, this.directory(to.parent))
    )
      return failure(28);
    if (target?.kind === "dir" && node.kind !== "dir") return failure(31);
    if (target && target.kind !== "dir" && node.kind === "dir") return failure(54);
    if (target?.kind === "dir" && target.children.size) return failure(55);
    const parent = this.parentOf(to),
      source = this.parentOf(from);
    if (typeof parent === "number") return failure(parent);
    if (typeof source === "number") return failure(source);
    const edges = [
      { parent: source, name: from.name, before: node, after: undefined },
      { parent, name: to.name, before: target, after: node },
    ];
    return {
      plan: boundedNamespace(
        namespacePlan(
          edges,
          [],
          target ? [target] : [],
          target ? [{ node: target, delta: -1 }] : [],
        ),
        bound,
      ),
      result: 0,
    };
  }
  planMkdirp(
    path: string,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly node: DirNode } {
    const edges: NamespaceEdge[] = [],
      created: Node[] = [];
    const pending = new Map<DirNode, Map<string, Node>>();
    const child = (parent: DirNode, name: string): Node => {
      const found = pending.get(parent)?.get(name) ?? parent.children.get(name);
      if (found) return found;
      const node = this.planDirectoryChild(parent, name, edges, created, bound);
      let entries = pending.get(parent);
      if (!entries) {
        entries = new Map();
        pending.set(parent, entries);
      }
      entries.set(name, node);
      return node;
    };
    const resolved = walkTree(this.root, path || ".", {
      clampRoot: true,
      followFinal: true,
      child,
    });
    if (typeof resolved === "number") throw new FilesystemError(resolved);
    const node = resolved.node;
    if (node?.kind !== "dir") throw new FilesystemError(54);
    const plan = boundedNamespace(
      namespacePlan(
        edges,
        created,
        [],
        created.map((entry) => ({ node: entry, delta: 1 })),
      ),
      bound,
    );
    return { plan, node };
  }
  planHostFile(
    path: string,
    exclusive: boolean,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly node: FileNode } {
    path = path.startsWith("/") ? path : "/" + path;
    const resolved = this.resolveAbsolute(path, !exclusive);
    if (typeof resolved === "number" && resolved !== 44) throw new FilesystemError(resolved);
    if (
      typeof resolved !== "number" &&
      resolved.node !== undefined &&
      this.nodeForHandle(resolved.node).kind === "dir"
    )
      throw new FilesystemError(31);
    if (typeof resolved !== "number" && resolved.trailingSlash) throw new FilesystemError(54);
    const prepared =
      typeof resolved !== "number" && resolved.parent !== undefined
        ? { node: this.directory(resolved.parent), plan: namespacePlan() }
        : this.planMkdirp(dirname(path), bound);
    const parent = prepared.node;
    const name = typeof resolved === "number" ? basename(path) : resolved.name;
    const existing = parent.children.get(name);
    this.require(parent, 1);
    if (existing && exclusive) throw new FilesystemError(20);
    if (existing && existing.kind !== "file") throw new FilesystemError(31);
    if (existing) {
      this.require(existing, 2);
      return { plan: prepared.plan, node: existing };
    }
    this.require(parent, 3);
    const node = newFile();
    const edits = prepared.plan.edits.concat([{ parent, name, before: undefined, after: node }]);
    const created = prepared.plan.created.concat([node]);
    const links = prepared.plan.links.concat([{ node, delta: 1 }]);
    return { plan: boundedNamespace(namespacePlan(edits, created, [], links), bound), node };
  }
  private planDirectoryChild(
    parent: DirNode,
    name: string,
    edges: NamespaceEdge[],
    created: Node[],
    bound: number,
  ): DirNode {
    this.require(parent, 2);
    if (edges.length * 3 + 3 > bound)
      throw new FilesystemError(6, "namespace effect bound exceeded");
    const child = newDir();
    edges.push({ parent, name, before: undefined, after: child });
    created.push(child);
    return child;
  }
  planRemove(
    path: string,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly result: boolean } {
    const parent = this.lookup(dirname(path));
    if (parent?.kind !== "dir") return { plan: namespacePlan(), result: false };
    this.require(parent, 3);
    const name = basename(path),
      node = parent.children.get(name);
    if (!node) return { plan: namespacePlan(), result: false };
    const plan = namespacePlan(
      [{ parent, name, before: node, after: undefined }],
      [],
      [node],
      [{ node, delta: -1 }],
    );
    const edges = plan.edges.slice();
    const pending: Node[] = [node];
    while (pending.length) this.collectRemovalEdges(pending.pop()!, pending, edges, bound);
    return { plan: boundedNamespace({ ...plan, edges }, bound), result: true };
  }
  private collectRemovalEdges(
    node: Node,
    pending: Node[],
    edges: NamespaceEdge[],
    bound: number,
  ): void {
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
    for (const node of plan.created) {
      node.mtime = plan.mtime;
      this.changed(node);
    }
    for (const parent of plan.parents) {
      parent.mtime = plan.mtime;
      this.changed(parent);
    }
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

  lookup(path: string): Exclude<Node, SymlinkNode> | undefined;
  lookup(path: string, followFinal: boolean): Node | undefined;
  lookup(path: string, followFinal = true): Node | undefined {
    const resolved = this.resolveAbsolute(path.startsWith("/") ? path : "/" + path, followFinal);
    if (typeof resolved === "number") {
      if (resolved === 44) return;
      throw new FilesystemError(resolved);
    }
    return resolved.node === undefined ? undefined : this.nodeForHandle(resolved.node);
  }
  mkdirp(path: string): DirNode {
    const prepared = this.planMkdirp(path, Number.MAX_SAFE_INTEGER);
    this.applyNamespace(prepared.plan);
    return prepared.node;
  }
  writeFile(path: string, content: string | Uint8Array, append = false): void {
    const data = typeof content === "string" ? encode(content) : content;
    const prepared = this.planHostFile(path, false, Number.MAX_SAFE_INTEGER);
    this.applyNamespace(prepared.plan);
    const node = prepared.node;
    if (append) {
      const merged = new Uint8Array(node.data.length + data.length);
      merged.set(node.data);
      merged.set(data, node.data.length);
      node.data = merged;
    } else node.data = data;
    node.mtime = Date.now();
    this.changed(node);
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
      if (node.kind !== "dir") return;
      this.require(node, 5);
      for (const [name, child] of node.children)
        walk(child, path === "/" ? `/${name}` : `${path}/${name}`);
    };
    const start = this.resolveAbsolute(dir.startsWith("/") ? dir : "/" + dir, true);
    if (typeof start === "number") {
      if (start === 44) return out;
      throw new FilesystemError(start);
    }
    if (start.node !== undefined) walk(this.nodeForHandle(start.node), start.canonicalPath);
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
