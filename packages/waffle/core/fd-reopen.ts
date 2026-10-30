import {
  RIGHT_FD_READ as READ,
  RIGHT_FD_WRITE as WRITE,
  RIGHT_PATH_OPEN as PATH_OPEN,
  RIGHT_PATH_FILESTAT_SET_SIZE as PATH_RESIZE,
} from "./rights.js";
import type { Descriptor, DescriptorTable } from "./descriptors.js";
import type { FileSystem } from "./filesystem.js";
import { normalize } from "./path.js";

export type DescriptorPath = { source: number } | { device: "null" };

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
): number {
  if (fs.stat(handle).kind === "socket") return -60;
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
  return table.open(
    kind === "directory"
      ? { kind, handle }
      : { kind, handle, offset: 0, append: (fdflags & 1) !== 0, fdflags },
    base,
    inheriting,
    () => fs.release(handle),
  );
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

type PathEntry = { prefix: string } & (
  | { kind: "symlink"; handle: number; source?: never }
  | { kind: "file" | "directory" | "socket" | "device"; handle?: number; source?: number }
);
const virtualDirectories = ["/dev", "/dev/fd", "/proc", "/proc/self", "/proc/self/fd"];

function lookupEntry(
  table: DescriptorTable,
  fs: FileSystem,
  parent: PathEntry,
  name: string,
): PathEntry | number {
  const prefix = `${parent.prefix}/${name}`;
  const source = descriptorPath(prefix);
  if (source !== undefined) {
    const resource = table.get(source)?.resource;
    if (!resource) return 44;
    return {
      prefix,
      source,
      kind: resource.kind === "directory" ? "directory" : "file",
      handle:
        resource.kind === "directory" || resource.kind === "file" ? resource.handle : undefined,
    };
  }
  if (devicePath(prefix) !== undefined) return { prefix, kind: "device" };
  const path = parent.handle === undefined ? undefined : fs.resolve(parent.handle, name, false);
  if (typeof path === "number") return path;
  if (path?.node !== undefined) return { prefix, handle: path.node, kind: fs.stat(path.node).kind };
  if (virtualDirectories.includes(prefix)) return { prefix, kind: "directory" };
  return 44;
}

function searchEntry(fs: FileSystem, entry: PathEntry): number {
  if (entry.kind !== "directory") return 54;
  if (entry.handle === undefined) return 0;
  const result = fs.resolve(entry.handle, ".");
  return typeof result === "number" ? result : 0;
}

type FinalLinkPolicy = "follow" | "nofollow" | "exclusive-create";

/** Undefined delegates ordinary paths unchanged, without per-component service calls. */
export function resolveDescriptorPath(
  table: DescriptorTable,
  fs: FileSystem,
  directory: Descriptor,
  path: string,
  finalLink: FinalLinkPolicy,
): DescriptorPath | number | undefined {
  // Normalization only selects candidates. The walker below authorizes the ORIGINAL path:
  // canceled components, root escape and terminal slashes/dots are never discarded there.
  if (!path.includes("dev") && !path.includes("proc")) return undefined;
  const normalized = normalize(path);
  if (descriptorPath(normalized) === undefined && devicePath(normalized) === undefined)
    return undefined;
  if (directory.resource.kind !== "directory") return undefined;
  const handle = directory.resource.handle;
  if (directory.preopen !== "/" && fs.stat(handle).ino !== fs.stat(fs.preopen("/")).ino)
    return undefined;
  let current: PathEntry = { prefix: "", kind: "directory", handle };
  const parents: PathEntry[] = [];
  let pending = path.split("/"),
    offset = 0,
    expansions = 0;
  while (offset < pending.length) {
    const part = pending[offset++];
    if (!part) continue;
    const error = searchEntry(fs, current);
    if (error) return error;
    if (part === ".") continue;
    if (part === "..") {
      const parent = parents.pop();
      if (!parent) return 63;
      current = parent;
      continue;
    }
    const next = lookupEntry(table, fs, current, part);
    if (typeof next === "number") return next;
    if (next.kind === "symlink") {
      const final = !pending.slice(offset).some(Boolean);
      if (final && finalLink !== "follow" && pending[pending.length - 1] === "") return 54;
      if (final && finalLink === "exclusive-create") return 20;
      if (final && finalLink === "nofollow") return 32;
      if (++expansions > 40) return 32;
      const target = fs.readlink(next.handle);
      if (!target) return 44;
      if (target.startsWith("/")) return 63;
      pending = target.split("/").concat(pending.slice(offset));
      offset = 0;
      continue;
    }
    parents.push(current);
    current = next;
  }
  if (path.endsWith("/") && current.kind !== "directory") return 54;
  if (current.source !== undefined) return { source: current.source };
  return current.kind === "device" ? { device: "null" } : undefined;
}
