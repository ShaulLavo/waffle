import { DirectoryPages, checkDirectoryPage } from "./directory-pages.js";
import { utf8ByteLength } from "./utf8-size.js";
import type { FileIdentity } from "./file-identity.js";
import type { NodeMetadata } from "./workspace-types.js";
import {
  permissionsFor,
  FilesystemError,
  fileTimeNow,
  type FileTime,
  type SocketBinding,
} from "../core/filesystem.js";
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

/** Nanoseconds since 1970. Times taken together share one bigint. */
export interface NodeTimes {
  atime: FileTime;
  mtime: FileTime;
  ctime: FileTime;
}
export function nodeTimes(time: FileTime = fileTimeNow()): NodeTimes {
  return { atime: time, mtime: time, ctime: time };
}
/** Content changes set mtime and ctime, as Linux does for write and truncate. */
function modified(node: NodeTimes, time: FileTime): void {
  node.mtime = time;
  node.ctime = time;
}

export interface FileNode extends NodeTimes {
  identity?: FileIdentity;
  kind: "file";
  data: Uint8Array;
  /** Logical size when the persistence backend keeps the payload outside this object. */
  size?: number;
  mode: number;
  ino: number;
}

export interface DirNode extends NodeTimes {
  identity?: FileIdentity;
  kind: "dir";
  children: Map<string, Node>;
  mode: number;
  ino: number;
}

export interface SymlinkNode extends NodeTimes {
  identity?: FileIdentity;
  kind: "symlink";
  readonly target: string;
  mode: number;
  ino: number;
}
export interface SocketNode extends NodeTimes {
  identity?: FileIdentity;
  kind: "socket";
  lease?: number;
  mode: number;
  ino: number;
}
export type Node = FileNode | DirNode | SymlinkNode | SocketNode;
export function newSocket(): SocketNode {
  return { kind: "socket", mode: 0o600, ...nodeTimes(), ino: newIno() };
}

export function newSymlink(target: string): SymlinkNode {
  return { kind: "symlink", target, mode: 0o600, ...nodeTimes(), ino: newIno() };
}
export function nodeKind(node: Node): FileStat["kind"] {
  return node.kind === "dir" ? "directory" : node.kind;
}
export function nodeMetadata(node: Node): NodeMetadata {
  if (node.kind === "symlink") return { kind: "symlink", target: node.target };
  return { kind: node.kind === "dir" ? "directory" : node.kind };
}
export function nodeSize(node: Node): number {
  if (node.kind === "symlink") return utf8ByteLength(node.target);
  return node.kind === "file" ? (node.size ?? node.data.length) : 0;
}
interface MemoryPath extends ResolvedPath {
  readonly canonicalPath: string;
  readonly base: PathBase;
}
/** What a walk's `canonicalPath` is relative to: the start directory, the rooted walk's root
 * (after an absolute link target), or neither (a rooted `..` climbed above the start). */
type PathBase = "start" | "root" | "lost";
interface TreePath {
  canonicalPath: string;
  base: PathBase;
  parent: DirNode | undefined;
  node: Node | undefined;
  name: string;
  trailingSlash: boolean;
  terminalDot: boolean;
}
interface TreeWalk {
  followFinal?: boolean;
  clampRoot: boolean;
  child?: (parent: DirNode, name: string, origin: "input" | "target") => Node | undefined;
  search?: (node: DirNode) => void;
  depth?: number;
  pathUnits?: number;
  pathBytes?: number;
  /** A lookup in the guest's root namespace, as Linux does it: absolute link targets restart at
   * `root`, and `..` climbs above the start directory through `parentOf`, stopping at `root`. */
  rooted?: RootedWalk;
}
interface RootedWalk {
  readonly root: DirNode;
  /** The directory holding `dir`, or a WASI errno when it has none. */
  parentOf(dir: DirNode): DirNode | number;
}
/** Where `..` leads when the walk has no directory of its own left to pop. */
function climbAbove(node: DirNode, start: DirNode, options: TreeWalk): DirNode | number {
  const rooted = options.rooted;
  if (rooted) return node === rooted.root ? node : rooted.parentOf(node);
  return options.clampRoot ? start : 63;
}
function treePathError(path: string, limit: number | undefined, bytes?: number): number {
  if (!path) return 44;
  if (path.includes("\0")) return 28;
  if (bytes !== undefined && /\p{Surrogate}/u.test(path)) return 28;
  if (bytes !== undefined && utf8ByteLength(path) > bytes) return 37;
  return limit !== undefined && path.length > limit ? 37 : 0;
}
function expandTreeLink(
  child: Node,
  path: string,
  start: number,
  options: TreeWalk,
  expansions: number,
  targetEnd: number,
):
  | { readonly path: string; readonly absolute: boolean; readonly targetEnd: number }
  | number
  | undefined {
  if (child.kind !== "symlink") return;
  if (!options.followFinal && !/[^/]/.test(path.slice(start))) return;
  if (expansions >= 40) return 32;
  const target = child.target;
  if (!target) return 44;
  const absolute = target.startsWith("/");
  if (absolute && !options.clampRoot && !options.rooted) return 63;
  const suffix = path.slice(start);
  const expanded = target + (suffix || path.endsWith("/") ? "/" + suffix : "");
  const error = treePathError(expanded, options.pathUnits, options.pathBytes);
  return (
    error || {
      path: expanded,
      absolute,
      targetEnd: target.length + (targetEnd > start ? 1 + targetEnd - start : 0),
    }
  );
}
/** A rooted `..` above the start leaves names that no longer start anywhere known. */
function climbedBase(base: PathBase, aboveStart: boolean): PathBase {
  return aboveStart && base === "start" ? "lost" : base;
}
/** An absolute link target restarts the names at the rooted walk's root. */
function restartedBase(base: PathBase, options: TreeWalk): PathBase {
  return options.rooted ? "root" : base;
}
/** Expand links against actual parent edges, never a lexically normalized pathname. */
export function walkTree(root: DirNode, path: string, options: TreeWalk): TreePath | number {
  const error = treePathError(path, options.pathUnits, options.pathBytes);
  if (error) return error;
  const dirs: DirNode[] = [];
  const names: string[] = [];
  let node: Node = root;
  let parent: DirNode | undefined;
  let base: PathBase = "start";
  let name = "",
    terminalDot = false,
    expansions = 0,
    targetEnd = 0,
    start = 0;
  while (start < path.length) {
    let end = path.indexOf("/", start);
    if (end < 0) end = path.length;
    const origin = start < targetEnd ? "target" : "input";
    const part = path.slice(start, end);
    start = end + 1;
    if (!part) continue;
    if (node.kind !== "dir") return 54;
    if (options.search) options.search(node);
    else if (!(node.mode & 0o100)) return 2;
    terminalDot = part === "." || part === "..";
    if (part === ".") continue;
    if (part === "..") {
      const popped = dirs.pop();
      const up: DirNode | number = popped ?? climbAbove(node, root, options);
      if (typeof up === "number") return up;
      base = climbedBase(base, popped === undefined && up !== node);
      node = up;
      names.pop();
      parent = undefined;
      name = "";
      continue;
    }
    parent = node;
    name = part;
    const child: Node | undefined = options.child
      ? options.child(parent, part, origin)
      : parent.children.get(part);
    if (!child && /[^/]/.test(path.slice(start))) return 44;
    if (!child)
      return {
        canonicalPath: "/" + names.concat(part).join("/"),
        base,
        parent,
        name,
        node: undefined,
        trailingSlash: path.endsWith("/"),
        terminalDot: false,
      };
    const link = expandTreeLink(child, path, start, options, expansions, targetEnd);
    if (typeof link === "number") return link;
    if (link?.absolute) {
      dirs.length = 0;
      names.length = 0;
      base = restartedBase(base, options);
    }
    if (link) {
      expansions++;
      if (link.absolute) node = options.rooted?.root ?? root;
      path = link.path;
      targetEnd = link.targetEnd;
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
  return {
    parent,
    name,
    node,
    trailingSlash,
    terminalDot,
    canonicalPath: "/" + names.join("/"),
    base,
  };
}

/** `below` ("/" or "/a/b") appended to the absolute directory path `prefix`, or its errno. */
function joinBelow(prefix: string | number, below: string): string | number {
  if (typeof prefix === "number" || below === "/") return prefix;
  return (prefix === "/" ? "" : prefix) + below;
}
function childName(parent: DirNode, child: Node): string | undefined {
  for (const [name, entry] of parent.children) if (entry === child) return name;
  return undefined;
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
  /** One clock reading for every time this plan sets. */
  readonly time: FileTime;
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
    time: fileTimeNow(),
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
  return { kind: "dir", mode: 0o700, children: new Map(), ...nodeTimes(), ino: newIno() };
}

export function newFile(data: Uint8Array = new Uint8Array(0)): FileNode {
  return { kind: "file", mode: 0o600, data, ...nodeTimes(), ino: newIno() };
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
  private rootedCache?: RootedWalk;
  private rootedWalk(): RootedWalk {
    if (this.rootedCache?.root === this.root) return this.rootedCache;
    this.rootedCache = { root: this.root, parentOf: (dir) => this.liveParent(dir) };
    return this.rootedCache;
  }
  /** Where `..` leads from a directory. As on Linux, a removed directory still leads to the
   * parent it had, which the walk that reached it recorded. */
  private liveParent(dir: DirNode): DirNode | number {
    const parent = this.directoryParents.get(dir) ?? this.directoryParent(dir);
    if (parent && parent !== dir) return parent;
    return this.removedDirectories.has(dir) ? 44 : 63;
  }
  private pages = new WeakMap<DirNode, DirectoryPages>();
  private directoryPages(node: DirNode): DirectoryPages {
    let pages = this.pages.get(node);
    if (pages) return pages;
    pages = new DirectoryPages();
    for (const [name, child] of node.children)
      pages.set({ name, ino: child.ino, kind: nodeKind(child) });
    this.pages.set(node, pages);
    return pages;
  }
  private pageEntry(parent: DirNode, name: string, node: Node | undefined): void {
    const pages = this.directoryPages(parent);
    if (node) pages.set({ name, ino: node.ino, kind: nodeKind(node) });
    else pages.delete(name);
  }
  readdirPage(
    handle: FileHandle,
    cookie: bigint,
    byteLength: number,
    cookieTag?: bigint,
    maxBytes?: number,
    hardCapBytes?: number,
  ): Uint8Array {
    checkDirectoryPage(cookie, byteLength);
    const node = this.directory(handle);
    this.require(node, 4);
    const parent = this.directoryParents.get(node) ?? node;
    return this.directoryPages(node).page(
      cookie,
      byteLength,
      node.ino,
      parent.ino,
      cookieTag,
      maxBytes,
      hardCapBytes,
    );
  }
  private linkCounts = new WeakMap<Node, number>();

  linkCount(node: Node): number {
    return this.linkCounts.get(node) ?? 0;
  }
  private changeLinkCount(node: Node, delta: 1 | -1): void {
    this.linkCounts.set(node, this.linkCount(node) + delta);
  }

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
      for (const child of node.children.values()) {
        this.changeLinkCount(child, -1);
        this.forget(child);
      }
      // Recursive removal removes directory entries, not the bytes of separately open files.
      this.directoryPages(node).clear();
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
  socketParentAccess(root: FileHandle, parent: FileHandle): number {
    const target = this.nodeForHandle(parent),
      directory = this.nodeForHandle(root);
    if (target.kind !== "dir" || directory.kind !== "dir") return 76;
    return this.searchDirectory(directory, target) ?? 76;
  }
  private searchDirectory(directory: DirNode, target: DirNode): number | undefined {
    if (directory === target) return directory.mode & 0o100 ? 0 : 2;
    for (const child of directory.children.values()) {
      if (child.kind !== "dir") continue;
      const result = this.searchDirectory(child, target);
      if (result !== undefined) return directory.mode & 0o100 ? result : 2;
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
  resolve(
    directory: FileHandle,
    path: string,
    followFinal = false,
    rooted = false,
  ): ResolvedPath | number {
    if (path.startsWith("/")) return 63;
    const resolved = this.walk(directory, path, false, followFinal, undefined, rooted);
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
    pathBytes?: number,
    rooted = false,
  ): MemoryPath | number {
    const resolved = this.walkNodes(
      this.directory(directory),
      path,
      clampRoot,
      followFinal,
      pathBytes,
      rooted,
    );
    if (typeof resolved === "number") return resolved;
    return {
      canonicalPath: resolved.canonicalPath,
      base: resolved.base,
      name: resolved.name,
      trailingSlash: resolved.trailingSlash,
      terminalDot: resolved.terminalDot,
      parent: resolved.parent ? this.handle(resolved.parent) : undefined,
      node: resolved.node ? this.handle(resolved.node) : undefined,
    };
  }
  private walkNodes(
    start: DirNode,
    path: string,
    clampRoot: boolean,
    followFinal: boolean,
    pathBytes?: number,
    rooted = false,
  ): TreePath | number {
    return walkTree(start, path, {
      clampRoot,
      followFinal,
      pathBytes,
      rooted: rooted ? this.rootedWalk() : undefined,
      child: (parent, name) => {
        const child = parent.children.get(name);
        if (child?.kind === "dir") this.directoryParents.set(child, parent);
        return child;
      },
    });
  }
  /** realpath(3) from `directory`: what `path` names with every link followed, in one lookup.
   * A rooted lookup answers with an absolute path from the root. Any other lookup cannot leave
   * `directory`, and answers relative to it ("." for the directory itself). Errors are the
   * lookup's positive WASI errno: ENOENT for a missing component, ENOTDIR, ELOOP, EACCES. */
  realpath(directory: FileHandle, path: string, rooted = false): string | number {
    if (path.startsWith("/")) return 63;
    const start = this.directory(directory);
    const resolved = this.walkNodes(start, path, false, true, undefined, rooted);
    if (typeof resolved === "number") return resolved;
    if (resolved.node === undefined) return 44;
    if (!rooted) return resolved.canonicalPath.slice(1) || ".";
    if (resolved.base === "root" || (resolved.base === "start" && start === this.root))
      return resolved.canonicalPath;
    if (resolved.base === "start") return joinBelow(this.pathOf(start), resolved.canonicalPath);
    // A `..` above the start left the walk's names behind: name the result by its ancestry.
    if (resolved.node.kind === "dir") return this.pathOf(resolved.node);
    return joinBelow(this.pathOf(resolved.parent!), "/" + resolved.name);
  }
  /** The absolute path of a live directory, by its parent edges up to the root. */
  private pathOf(dir: DirNode): string | number {
    const names: string[] = [];
    for (let at = dir; at !== this.root;) {
      const parent = this.liveParent(at);
      if (typeof parent === "number") return parent === 63 ? 44 : parent;
      const name = childName(parent, at);
      if (name === undefined) return 44;
      names.push(name);
      at = parent;
    }
    return "/" + names.reverse().join("/");
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
      nlink: this.linkCount(node),
      size: nodeSize(node),
      atime: node.atime,
      mtime: node.mtime,
      ctime: node.ctime,
      mode: node.mode,
    };
  }
  permissions(handle: FileHandle) {
    const node = this.nodeForHandle(handle);
    return permissionsFor(nodeKind(node), node.mode);
  }
  /** Host policy mutation. All inodes belong to the same virtual principal. */
  setMode(handle: FileHandle, mode: number, time = fileTimeNow()): number {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0xffffffff) return 28;
    const node = this.nodeForHandle(handle);
    if (mode & ~this.permissions(handle).modeSupported) return 58;
    node.mode = mode;
    node.ctime = time;
    this.changed(node);
    return 0;
  }
  private require(node: Node, access: number): void {
    if (((node.mode >>> 6) & access) !== access) throw new FilesystemError(2);
  }
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number {
    const node = this.nodeForHandle(handle);
    if (node.kind !== "file") return node.kind === "socket" ? -60 : -31;
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
    const node = this.nodeForHandle(handle);
    if (node.kind !== "file") return node.kind === "socket" ? -60 : -31;
    if (!(node.mode & 0o200)) return -2;
    if (chunks.every((chunk) => chunk.length === 0)) return 0;
    let pos = offset;
    for (const chunk of chunks) {
      ensureSize(node, pos + chunk.length);
      node.data.set(chunk, pos);
      pos += chunk.length;
    }
    modified(node, fileTimeNow());
    return pos - offset;
  }
  append(
    handle: FileHandle,
    chunks: readonly Uint8Array[],
  ): { written: number; offset: number } | number {
    const node = this.nodeForHandle(handle);
    if (node.kind !== "file") return node.kind === "socket" ? -60 : -31;
    const offset = node.data.length;
    const written = this.write(handle, chunks, offset);
    return written < 0 ? written : { written, offset: offset + written };
  }
  resize(handle: FileHandle, size: number, truncate: boolean): number {
    const node = this.nodeForHandle(handle);
    if (node.kind !== "file") return node.kind === "socket" ? 60 : 31;
    if (!(node.mode & 0o200)) return 2;
    if (truncate && size < node.data.length) node.data = node.data.slice(0, size);
    else ensureSize(node, size);
    if (truncate) modified(node, fileTimeNow());
    return 0;
  }
  setTimes(
    handle: FileHandle,
    atime: FileTime | null,
    mtime: FileTime | null,
    ctime = fileTimeNow(),
  ): number {
    // The one virtual principal owns every inode, and Linux lets the owner set times on a
    // read-only file (tar -x and cp -p rely on it), so mode bits do not apply here.
    const node = this.nodeForHandle(handle);
    if (atime === null && mtime === null) return 0;
    if (atime !== null) node.atime = atime;
    if (mtime !== null) node.mtime = mtime;
    node.ctime = ctime;
    this.changed(node);
    return 0;
  }
  forEachDirEntry(handle: FileHandle, visit: (entry: DirectoryEntry) => void): void {
    const node = this.directory(handle);
    this.require(node, 4);
    const parent = this.directoryParents.get(node) ?? node;
    const entry = (name: string, item: Node): DirectoryEntry => ({
      name,
      ino: item.ino,
      kind: nodeKind(item),
    });
    visit(entry(".", node));
    visit(entry("..", parent));
    for (const [name, child] of node.children) visit(entry(name, child));
  }
  readdir(handle: FileHandle): DirectoryEntry[] {
    const list: DirectoryEntry[] = [];
    // One list per call, not one list per entry or cookie. No file buffers cross the boundary.
    this.forEachDirEntry(handle, (entry) => list.push(entry));
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
    kind: "file" | "directory" | "socket",
    exclusive = true,
  ): FileHandle | { error: number } {
    if (kind === "socket" && !exclusive) return { error: 28 };
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { error: parent };
    const existing = parent.children.get(path.name);
    if (existing) return !exclusive && kind === "file" ? this.handle(existing) : { error: 20 };
    const node = kind === "file" ? newFile() : kind === "socket" ? newSocket() : newDir();
    this.directoryPages(parent).reserve(1);
    this.pageEntry(parent, path.name, node);
    parent.children.set(path.name, node);
    this.changeLinkCount(node, 1);
    this.onLinkChange?.(node, 1);
    modified(parent, node.ctime);
    this.changed(node);
    this.changed(parent);
    if (node.kind === "dir") this.directoryParents.set(node, parent);
    return this.handle(node);
  }
  resolveSocket(directory: FileHandle, path: string, followFinal = false): ResolvedPath | number {
    if (typeof path !== "string") return 28;
    if (!path || path.includes("\0") || /\p{Surrogate}/u.test(path)) return path ? 28 : 44;
    if (utf8ByteLength(path) > 4096) return 37;
    const result = this.walk(
      directory,
      path.replace(/^\/+/, "") || ".",
      this.nodeForHandle(directory) === this.root,
      followFinal,
      4096,
    );
    return result === 63 ? 76 : result;
  }
  bindSocket(parent: FileHandle, name: string, lease: number): SocketBinding | { error: number } {
    const prepared = this.planBindSocket(parent, name, lease, 4);
    this.applyNamespace(prepared.plan);
    return prepared.result;
  }
  planBindSocketPath(
    directory: FileHandle,
    path: string,
    lease: number,
    bound: number,
  ): { plan: NamespacePlan; result: { binding: SocketBinding; name: string } | { error: number } } {
    const resolved = this.resolveSocket(directory, path, false);
    if (typeof resolved === "number") return { plan: namespacePlan(), result: { error: resolved } };
    if (resolved.parent === undefined || resolved.terminalDot)
      return { plan: namespacePlan(), result: { error: 28 } };
    if (resolved.trailingSlash && resolved.node === undefined)
      return { plan: namespacePlan(), result: { error: 44 } };
    const prepared = this.planBindSocket(resolved.parent, resolved.name, lease, bound);
    return {
      plan: prepared.plan,
      result:
        "error" in prepared.result
          ? prepared.result
          : { binding: prepared.result, name: resolved.name },
    };
  }
  planBindSocket(
    parent: FileHandle,
    name: string,
    lease: number,
    bound: number,
  ): { plan: NamespacePlan; result: SocketBinding | { error: number } } {
    if (
      !name ||
      name === "." ||
      name === ".." ||
      /[/\0]/.test(name) ||
      !Number.isSafeInteger(lease) ||
      lease <= 0
    )
      return { plan: namespacePlan(), result: { error: 28 } };
    const prepared = this.planCreate(
      { parent, name, node: undefined, trailingSlash: false, terminalDot: false },
      "socket",
      true,
      bound,
    );
    if (typeof prepared.result !== "number")
      return { plan: prepared.plan, result: prepared.result };
    const node = this.nodeForHandle(prepared.result);
    if (node.kind !== "socket") throw new FilesystemError(29);
    node.lease = lease;
    return {
      plan: prepared.plan,
      result: {
        node: prepared.result,
        parent,
        ino: node.ino,
        parentIno: this.nodeForHandle(parent).ino,
      },
    };
  }
  unbindSocket(binding: SocketBinding, name: string, lease: number, unlink: boolean): number {
    const prepared = this.planUnbindSocket(binding, name, lease, unlink, 4);
    this.applyNamespace(prepared.plan);
    return prepared.result;
  }
  planUnbindSocket(
    binding: SocketBinding,
    name: string,
    lease: number,
    unlink: boolean,
    bound: number,
  ): { plan: NamespacePlan; result: number } {
    const parent = this.nodeForHandle(binding.parent),
      node = this.nodeForHandle(binding.node);
    if (
      parent.kind !== "dir" ||
      parent.ino !== binding.parentIno ||
      node.kind !== "socket" ||
      node.ino !== binding.ino ||
      node.lease !== lease
    )
      return { plan: namespacePlan(), result: 44 };
    if (!unlink) return { plan: namespacePlan(), result: 0 };
    if (parent.children.get(name) !== node) return { plan: namespacePlan(), result: 44 };
    return this.planRemovePath(
      {
        parent: binding.parent,
        name,
        node: binding.node,
        trailingSlash: false,
        terminalDot: false,
      },
      false,
      bound,
    );
  }
  connectSocket(directory: FileHandle, path: string): { ino: number } | { error: number } {
    const resolved = this.resolveSocket(directory, path, true);
    if (typeof resolved === "number") return { error: resolved };
    if (resolved.node === undefined) return { error: 44 };
    const node = this.nodeForHandle(resolved.node);
    if (node.kind !== "socket") return { error: 14 };
    return node.mode & 0o200 ? { ino: node.ino } : { error: 2 };
  }
  link(from: ResolvedPath, to: ResolvedPath): number {
    if (from.node === undefined) return 44;
    const node = this.nodeForHandle(from.node);
    if (node.kind === "socket") return 58;
    if (node.kind === "dir") return 63;
    if (to.node !== undefined) return 20;
    if (to.trailingSlash) return 54;
    const parent = this.parentOf(to);
    if (typeof parent === "number") return parent;
    this.directoryPages(parent).reserve(1);
    this.pageEntry(parent, to.name, node);
    parent.children.set(to.name, node);
    this.changeLinkCount(node, 1);
    this.onLinkChange?.(node, 1);
    const time = fileTimeNow();
    modified(parent, time);
    node.ctime = time;
    this.changed(parent);
    this.changed(node);
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
    this.pageEntry(parent, path.name, undefined);
    parent.children.delete(path.name);
    this.changeLinkCount(node, -1);
    this.onLinkChange?.(node, -1);
    const time = fileTimeNow();
    modified(parent, time);
    node.ctime = time;
    this.changed(parent);
    this.changed(node);
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
    this.directoryPages(parent).reserve(1);
    this.pageEntry(sourceParent, from.name, undefined);
    this.pageEntry(parent, to.name, node);
    sourceParent.children.delete(from.name);
    const time = fileTimeNow();
    modified(sourceParent, time);
    node.ctime = time;
    parent.children.set(to.name, node);
    if (node.kind === "dir") this.directoryParents.set(node, parent);
    if (target) {
      this.forget(target);
      this.changeLinkCount(target, -1);
      this.onLinkChange?.(target, -1);
    }
    if (target?.kind === "dir") this.removedDirectories.add(target);
    modified(parent, time);
    if (target) target.ctime = time;
    this.changed(sourceParent);
    this.changed(parent);
    this.changed(node);
    if (target) this.changed(target);
    return 0;
  }

  /** Plans refer to the actual nodes and edges. No mirror tree is built or mutated. */
  planCreate(
    path: ResolvedPath,
    kind: "file" | "directory" | "socket",
    exclusive: boolean,
    bound: number,
  ): { readonly plan: NamespacePlan; readonly result: FileHandle | { error: number } } {
    if (kind === "socket" && !exclusive) return { plan: namespacePlan(), result: { error: 28 } };
    const parent = this.parentOf(path);
    if (typeof parent === "number") return { plan: namespacePlan(), result: { error: parent } };
    const existing = parent.children.get(path.name);
    if (existing)
      return {
        plan: namespacePlan(),
        result: !exclusive && kind === "file" ? this.handle(existing) : { error: 20 },
      };
    const node = kind === "file" ? newFile() : kind === "socket" ? newSocket() : newDir();
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
    if (node.kind === "socket") return { plan: namespacePlan(), result: 58 };
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
    const child = (parent: DirNode, name: string, origin: "input" | "target"): Node => {
      const found = pending.get(parent)?.get(name) ?? parent.children.get(name);
      if (found) return found;
      if (origin === "target") throw new FilesystemError(44);
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
    if (existing?.kind === "symlink" && resolved === 44) throw new FilesystemError(44);
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
  /** `accept` sees the entry the path names, without following a final symlink. Rejecting it
   * plans nothing, so check and removal happen in this one synchronous planning step. */
  planRemove(
    path: string,
    bound: number,
    accept?: (node: Node) => boolean,
  ): { readonly plan: NamespacePlan; readonly result: boolean } {
    const edge = this.removalEdge(path);
    if (!edge || (accept && !accept(edge.node))) return { plan: namespacePlan(), result: false };
    const { parent, name, node } = edge;
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
  private removalEdge(path: string): { parent: DirNode; name: string; node: Node } | undefined {
    const resolved = this.resolveAbsolute(path.startsWith("/") ? path : "/" + path);
    if (resolved === 44) return;
    if (typeof resolved === "number") throw new FilesystemError(resolved);
    if (resolved.terminalDot || resolved.parent === undefined) return;
    const parent = this.directory(resolved.parent);
    this.require(parent, 3);
    if (resolved.node === undefined) return;
    return { parent, name: resolved.name, node: this.nodeForHandle(resolved.node) };
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
    const additions = new Map<DirNode, number>();
    for (const edge of plan.edits) {
      if (edge.after) additions.set(edge.parent, (additions.get(edge.parent) ?? 0) + 1);
    }
    for (const [parent, count] of additions) this.directoryPages(parent).reserve(count);
    const created = new Set(plan.created);
    for (const edge of plan.edits) {
      this.pageEntry(edge.parent, edge.name, edge.after);
      if (edge.before) this.changeLinkCount(edge.before, -1);
      if (edge.after) this.changeLinkCount(edge.after, 1);
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
      node.atime = node.mtime = node.ctime = plan.time;
      this.changed(node);
    }
    for (const parent of plan.parents) {
      modified(parent, plan.time);
      this.changed(parent);
    }
    // A name added or removed changes the inode's link set, and so its ctime.
    for (const edge of plan.edits)
      for (const node of [edge.before, edge.after]) {
        if (!node || created.has(node)) continue;
        node.ctime = plan.time;
        this.changed(node);
      }
  }
  discardNamespace(plan: NamespacePlan): void {
    for (const node of plan.created) this.forget(node);
  }

  private reconstructDirectory(directory: DirNode, pending: DirNode[]): void {
    this.directoryPages(directory);
    for (const child of directory.children.values()) {
      this.changeLinkCount(child, 1);
      if (child.kind === "dir") pending.push(child);
    }
  }

  constructor(public root: DirNode = newDir()) {
    adoptInodes(root);
    this.changeLinkCount(root, 1);
    const pending = [root];
    while (pending.length) this.reconstructDirectory(pending.pop()!, pending);
  }

  hasNode(target: Node): boolean {
    return this.linkCount(target) > 0;
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
    modified(node, fileTimeNow());
    this.changed(node);
  }
  readFile(path: string): Uint8Array | undefined {
    const node = this.lookup(path);
    if (node?.kind !== "file") return undefined;
    this.require(node, 4);
    return node.data;
  }

  remove(path: string): boolean {
    const edge = this.removalEdge(path);
    if (!edge) return false;
    const { parent, name, node } = edge;
    this.pageEntry(parent, name, undefined);
    const removed = parent.children.delete(name);
    if (removed) {
      this.changeLinkCount(node, -1);
      this.onLinkChange?.(node, -1);
      this.forget(node);
      const time = fileTimeNow();
      modified(parent, time);
      node.ctime = time;
      this.changed(parent);
      this.changed(node);
    }
    return removed;
  }

  /** Every regular file under `dir`, as absolute paths, sorted. */
  collectBoundedFilePaths(dir = "/", onFile?: (path: string) => void): string[] {
    const out: string[] = [];
    const walk = (node: Node, path: string) => {
      if (node.kind === "file") {
        onFile?.(path);
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
  listFiles(dir = "/"): string[] {
    return this.collectBoundedFilePaths(dir);
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
