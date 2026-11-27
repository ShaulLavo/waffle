import {
  RIGHT_FD_READ as READ,
  RIGHT_FD_WRITE as WRITE,
  RIGHT_PATH_OPEN as PATH_OPEN,
  RIGHT_PATH_FILESTAT_SET_SIZE as PATH_RESIZE,
} from "./rights.js";
import type { Descriptor, DescriptorTable } from "./descriptors.js";
import type { FileStat, FileSystem, ResolvedPath } from "./filesystem.js";
import { releaseOriginOfd } from "./open-file.js";
import { normalize } from "./path.js";

export type DescriptorPath = { source: number } | { device: "null" } | { resolved: ResolvedPath };

/** Open the inode again, not its old pathname. Negative results are WASI errno. */
export function reopenDescriptor(
  table: DescriptorTable,
  fs: FileSystem,
  fd: number,
  oflags: number,
  fdflags: number,
  base: bigint,
  inheriting = 0n,
): number {
  const source = table.get(fd);
  if (!source) return -8;
  if (oflags & ~15 || fdflags & ~31 || oflags & 5) return -28;
  base = BigInt.asUintN(64, base);
  inheriting = BigInt.asUintN(64, inheriting);
  if (source.resource.kind !== "file") {
    if (oflags & 2 && source.resource.kind !== "directory") return -54;
    if (oflags & 8 && source.resource.kind === "directory") return -31;
    if ((base & source.rightsBase) !== base) return -2;
    if ((inheriting & source.rightsInheriting) !== inheriting) return -2;
    return table.add(source.description, { rightsBase: base, rightsInheriting: inheriting });
  }
  if (oflags & 2) return -54;
  const root = table.rootPreopen();
  if (!root || !(root.rightsBase & PATH_OPEN)) return -76;
  if ((base & root.rightsInheriting) !== base) return -76;
  if ((inheriting & root.rightsInheriting) !== inheriting) return -76;
  if (oflags & 8 && !(root.rightsBase & PATH_RESIZE)) return -76;
  return openInode(table, fs, source.resource.handle, "file", oflags, fdflags, base, inheriting);
}

/** A new open description owns its flags, offset and one inode reference. */
export function openInode(
  table: DescriptorTable,
  fs: FileSystem,
  handle: number,
  kind: "file" | "directory",
  oflags: number,
  fdflags: number,
  base: bigint,
  inheriting: bigint,
  stat: FileStat = fs.stat(handle),
): number {
  if (stat.kind === "socket") return -60;
  const access = (base & READ ? 4 : 0) | (base & WRITE ? 2 : 0);
  const permissions = fs.permissions?.(handle);
  if (permissions && permissions.accessSupported & access & ~permissions.access) return -2;
  if (oflags & 2 && kind !== "directory") return -54;
  if (oflags & 8) {
    if (kind === "directory") return -31;
    const error = fs.resize(handle, 0, true);
    if (error) return -error;
  }
  fs.retain(handle);
  const resource =
    kind === "directory"
      ? ({ kind, handle } as const)
      : { kind, handle, offset: 0, append: (fdflags & 1) !== 0, fdflags };
  return table.open(resource, base, inheriting, () => releaseOriginOfd(fs, resource));
}

/** These names are process-local WASI paths, never entries in the shared filesystem. */
function descriptorPath(path: string): number | undefined {
  if (path === "/dev/stdin") return 0;
  if (path === "/dev/stdout") return 1;
  if (path === "/dev/stderr") return 2;
  const match = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d+)$/.exec(path);
  return match ? Number(match[1]) : undefined;
}

function devicePath(path: string): "null" | undefined {
  return path === "/dev/null" ? "null" : undefined;
}

/** One step of the alias walk. `prefix` is the entry's guest path when the walk knows it, which
 * is what makes virtual names visible below it; entries reached through a descriptor alias or by
 * climbing from a directory descriptor are physical only. `resolved` is the lookup that found it. */
interface PathEntry {
  prefix: string | undefined;
  kind: FileStat["kind"] | "device" | "missing";
  handle?: number;
  source?: number;
  resolved?: ResolvedPath;
}
const virtualDirectories = ["/dev", "/dev/fd", "/proc", "/proc/self", "/proc/self/fd"];

function virtualEntry(table: DescriptorTable, prefix: string): PathEntry | number | undefined {
  const source = descriptorPath(prefix);
  if (source === undefined)
    return devicePath(prefix) === undefined ? undefined : { prefix, kind: "device" };
  const resource = table.get(source)?.resource;
  if (!resource) return 44;
  return {
    prefix,
    source,
    kind: resource.kind === "directory" ? "directory" : "file",
    handle: resource.kind === "directory" || resource.kind === "file" ? resource.handle : undefined,
  };
}

function lookupEntry(
  table: DescriptorTable,
  fs: FileSystem,
  parent: PathEntry,
  name: string,
): PathEntry | number {
  const prefix =
    parent.prefix === undefined || parent.source !== undefined
      ? undefined
      : `${parent.prefix}/${name}`;
  const virtual = prefix === undefined ? undefined : virtualEntry(table, prefix);
  if (virtual !== undefined) return virtual;
  const path = parent.handle === undefined ? undefined : fs.resolve(parent.handle, name, false);
  if (typeof path === "number") return path;
  if (path?.node !== undefined)
    return { prefix, handle: path.node, kind: fs.stat(path.node).kind, resolved: path };
  if (prefix !== undefined && virtualDirectories.includes(prefix))
    return { prefix, kind: "directory" };
  return path ? { prefix, kind: "missing", resolved: path } : 44;
}

function searchEntry(fs: FileSystem, entry: PathEntry): number {
  if (entry.kind !== "directory") return 54;
  if (entry.handle === undefined) return 0;
  const result = fs.resolve(entry.handle, ".");
  return typeof result === "number" ? result : 0;
}

function sameInode(fs: FileSystem, a: number, b: number): boolean {
  return a === b || fs.stat(a).ino === fs.stat(b).ino;
}

/** The directories whose entry `name` the virtual namespace replaces. */
function shadowedParents(name: string): readonly string[] {
  if (name === "null" || name === "stdin" || name === "stdout" || name === "stderr") return ["dev"];
  return /^\d+$/.test(name) ? ["dev/fd", "proc/self/fd"] : [];
}

/** Whether an ordinary lookup landed on a physical entry that a virtual name replaces, however
 * the path spelled it (through a link, say). */
function virtualShadow(fs: FileSystem, root: number, path: ResolvedPath): boolean {
  if (path.parent === undefined) return false;
  for (const directory of shadowedParents(path.name)) {
    const found = fs.resolve(root, directory);
    if (typeof found !== "number" && found.node === path.parent) return true;
  }
  return false;
}

type FinalLinkPolicy = "follow" | "nofollow" | "exclusive-create";

function resolveOrdinaryPath(
  fs: FileSystem,
  handle: number,
  root: () => number,
  path: string,
  finalLink: FinalLinkPolicy,
  rooted: boolean,
): { resolved: ResolvedPath } | number | undefined {
  if (path.includes("dev") || path.includes("proc")) {
    const normalized = normalize(path);
    if (descriptorPath(normalized) !== undefined || devicePath(normalized) !== undefined)
      return undefined;
  }
  const resolved = fs.resolve(handle, path, finalLink === "follow", rooted);
  if (typeof resolved === "number") return resolved === 44 ? undefined : resolved;
  return virtualShadow(fs, root(), resolved) ? undefined : { resolved };
}

/** The target of a link the alias walker meets with `rest` still to walk, or the errno that stops it. */
function followedTarget(
  fs: FileSystem,
  link: number,
  rest: readonly string[],
  finalLink: FinalLinkPolicy,
  expansions: number,
  rooted: boolean,
): string | number {
  const final = !rest.some(Boolean);
  if (final && finalLink !== "follow" && rest[rest.length - 1] === "") return 54;
  if (final && finalLink === "exclusive-create") return 20;
  if (final && finalLink === "nofollow") return 32;
  if (expansions > 40) return 32;
  const target = fs.readlink(link);
  if (!target) return 44;
  return target.startsWith("/") && !rooted ? 63 : target;
}

/** Resolves original components, not normalized text, with one link budget for the whole path. */
class AliasWalk {
  private current: PathEntry;
  private readonly parents: PathEntry[] = [];
  private pending: string[];
  private offset = 0;
  private expansions = 0;
  private dot = false;
  constructor(
    private readonly table: DescriptorTable,
    private readonly fs: FileSystem,
    private readonly root: PathEntry & { handle: number },
    start: PathEntry,
    path: string,
    private readonly finalLink: FinalLinkPolicy,
    private readonly rooted: boolean,
  ) {
    this.current = start;
    this.pending = path.split("/");
  }
  run(): DescriptorPath | number | undefined {
    while (this.offset < this.pending.length) {
      const stop = this.step(this.pending[this.offset++]!);
      if (stop !== undefined) return stop;
    }
    return this.result();
  }
  /** One component; anything but undefined ends the walk with that answer. */
  private step(part: string): DescriptorPath | number | undefined {
    if (!part) return undefined;
    const error = searchEntry(this.fs, this.current);
    if (error) return error;
    this.dot = part === "." || part === "..";
    if (part === ".") return undefined;
    if (part === "..") return this.up();
    const next = lookupEntry(this.table, this.fs, this.current, part);
    if (typeof next === "number") return next;
    if (next.kind === "missing") return this.missing(next);
    if (next.kind === "symlink" && next.handle !== undefined) return this.expand(next.handle);
    this.parents.push(this.current);
    this.current = next;
    return undefined;
  }
  private final(): boolean {
    return !this.pending.slice(this.offset).some(Boolean);
  }
  /** Whether the path as expanded so far ends in a slash and so must name a directory. */
  private trailing(): boolean {
    return this.pending[this.pending.length - 1] === "";
  }
  private missing(entry: PathEntry): DescriptorPath | number {
    if (!this.final() || !entry.resolved) return 44;
    return { resolved: { ...entry.resolved, trailingSlash: this.trailing() } };
  }
  private expand(link: number): number | undefined {
    const rest = this.pending.slice(this.offset);
    const target = followedTarget(
      this.fs,
      link,
      rest,
      this.finalLink,
      ++this.expansions,
      this.rooted,
    );
    if (typeof target === "number") return target;
    if (target.startsWith("/")) this.restart(this.root);
    this.pending = target.split("/").concat(rest);
    this.offset = 0;
    return undefined;
  }
  private restart(entry: PathEntry): undefined {
    this.current = entry;
    this.parents.length = 0;
    return undefined;
  }
  /** `..`: the walked parent, or in a rooted lookup the physical parent of a directory reached
   * through a descriptor or held as the start, and the root's own parent is the root. */
  private up(): number | undefined {
    const current = this.current;
    if (current.prefix === "") {
      if (!this.rooted) return 63;
      return this.restart(this.root);
    }
    const physical = this.rooted && (current.source !== undefined || !this.parents.length);
    if (physical) return this.physicalParent(current);
    const parent = this.parents.pop();
    if (!parent) return 63;
    this.current = parent;
    return undefined;
  }
  private physicalParent(entry: PathEntry): number | undefined {
    if (entry.handle === undefined) return 44;
    const parent = this.fs.resolve(entry.handle, "..", false, true);
    if (typeof parent === "number") return parent;
    if (parent.node === undefined) return 44;
    const atRoot = sameInode(this.fs, parent.node, this.root.handle);
    const directory: PathEntry = { prefix: undefined, kind: "directory", handle: parent.node };
    return this.restart(atRoot ? this.root : directory);
  }
  private result(): DescriptorPath | number | undefined {
    const current = this.current;
    const trailing = this.trailing();
    if (trailing && current.kind !== "directory") return 54;
    if (current.source !== undefined) return { source: current.source };
    if (current.kind === "device") return { device: "null" };
    // A virtual directory with no physical one behind it: ordinary resolution answers.
    if (current.handle === undefined) return undefined;
    if (!this.dot && current.resolved)
      return { resolved: { ...current.resolved, trailingSlash: trailing } };
    const here = this.fs.resolve(current.handle, ".");
    return typeof here === "number" ? here : { resolved: { ...here, trailingSlash: trailing } };
  }
}

/** The directory every `/` in a rooted lookup means: the root preopen, or the filesystem root
 * when the guest has closed it. */
function rootHandle(table: DescriptorTable, fs: FileSystem, directory: Descriptor): number {
  if (directory.preopen === "/" && directory.resource.kind === "directory")
    return directory.resource.handle;
  const root = table.rootPreopen()?.resource;
  return root?.kind === "directory" ? root.handle : fs.preopen("/");
}

/** Ordinary paths return their one resolved result; virtual aliases use the component walker.
 * Without `rooted` only the root directory sees aliases. A `rooted` lookup is in the guest's
 * root namespace (see FileSystem.resolve) from any directory: an absolute target restarts at
 * the root, `..` climbs to it, and a path that reaches a virtual name through a link or `..`
 * opens it as the spelled-out path would. */
export function resolveDescriptorPath(
  table: DescriptorTable,
  fs: FileSystem,
  directory: Descriptor,
  path: string,
  finalLink: FinalLinkPolicy,
  rooted = false,
): DescriptorPath | number | undefined {
  if (directory.resource.kind !== "directory") return undefined;
  const handle = directory.resource.handle;
  if (!rooted && directory.preopen !== "/" && fs.stat(handle).ino !== fs.stat(fs.preopen("/")).ino)
    return undefined;
  let rootCache: number | undefined;
  const root = () => (rootCache ??= rooted ? rootHandle(table, fs, directory) : handle);
  const ordinary = resolveOrdinaryPath(fs, handle, root, path, finalLink, rooted);
  if (ordinary !== undefined || !path) return ordinary;
  const rootEntry = { prefix: "", kind: "directory", handle: root() } as const;
  if (!sameInode(fs, handle, rootEntry.handle)) {
    // Preview1 paths are relative to their directory; only the root binding spells `/dev/...`.
    if (path.startsWith("/")) return 63;
    const start: PathEntry = { prefix: undefined, kind: "directory", handle };
    return new AliasWalk(table, fs, rootEntry, start, path, finalLink, rooted).run();
  }
  return new AliasWalk(table, fs, rootEntry, rootEntry, path, finalLink, rooted).run();
}
