import type { Descriptor, DescriptorTable } from "./descriptors.js";
import type { FileSystem } from "./filesystem.js";

const READ = 1n << 1n;
const WRITE = 1n << 6n;
const PATH_OPEN = 1n << 13n;
const PATH_RESIZE = 1n << 19n;

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
  if (source.resource.kind !== "file") return reopenShared(table, source, oflags, base, inheriting);
  if (oflags & 2) return -54;
  const root = table.rootPreopen();
  if (!root || !(root.rightsBase & PATH_OPEN)) return -76;
  if ((base & root.rightsInheriting) !== base) return -76;
  if ((inheriting & root.rightsInheriting) !== inheriting) return -76;
  if (oflags & 8 && !(root.rightsBase & PATH_RESIZE)) return -76;
  const handle = source.resource.handle;
  const access = (base & READ ? 4 : 0) | (base & WRITE ? 2 : 0);
  const permissions = fs.permissions?.(handle);
  if (permissions && permissions.accessSupported & access & ~permissions.access) return -2;
  if (oflags & 8) {
    const error = fs.resize(handle, 0, true);
    if (error) return -error;
  }
  fs.retain(handle);
  return table.open(
    { kind: "file", handle, offset: 0, append: (fdflags & 1) !== 0, fdflags },
    base,
    inheriting,
    () => fs.release(handle),
  );
}

function reopenShared(
  table: DescriptorTable,
  source: Descriptor,
  oflags: number,
  base: bigint,
  inheriting: bigint,
): number {
  if (oflags & 2 && source.resource.kind !== "directory") return -54;
  if (oflags & 8 && source.resource.kind === "directory") return -31;
  if ((base & source.rightsBase) !== base) return -2;
  if ((inheriting & source.rightsInheriting) !== inheriting) return -2;
  return table.add(source.description, { rightsBase: base, rightsInheriting: inheriting });
}

/** These names are process-local WASI paths, never entries in the shared filesystem. */
export function descriptorPath(path: string): number | undefined {
  if (path === "/dev/stdin") return 0;
  if (path === "/dev/stdout") return 1;
  if (path === "/dev/stderr") return 2;
  const match = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d+)$/.exec(path);
  return match ? Number(match[1]) : undefined;
}
