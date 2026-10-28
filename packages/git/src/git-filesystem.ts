import type { Runtime } from "waffle";
import type { GitFilesystem, GitStat } from "./git-types";

class GitFilesystemError extends Error {
  constructor(
    readonly code: string,
    path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

/** Adapt only the caller's public Waffle filesystem capability, never its owner. */
export function gitFilesystem(filesystem: Runtime["filesystem"]): GitFilesystem {
  const entry = async (path: string) => {
    const found = await filesystem.lookup(path);
    if (!found) throw new GitFilesystemError("ENOENT", path);
    if (found.kind === "symlink") throw new GitFilesystemError("ENOTSUP", path);
    return found;
  };
  const directory = async (path: string) => {
    const found = await entry(path);
    if (found.kind !== "dir") throw new GitFilesystemError("ENOTDIR", path);
    return found;
  };
  const stat = async (path: string): Promise<GitStat> => {
    const found = await entry(path);
    const bytes = found.kind === "file" ? await filesystem.readFile(path) : undefined;
    return {
      mode: found.kind === "file" ? 0o100644 : 0o040755,
      size: bytes?.byteLength ?? 0,
      ino: found.ino,
      mtimeMs: found.mtime,
      ctimeMs: found.mtime,
      uid: 0,
      gid: 0,
      dev: 0,
      isFile: () => found.kind === "file",
      isDirectory: () => found.kind === "dir",
      isSymbolicLink: () => false,
    };
  };
  return {
    promises: {
      async readFile(path, encoding) {
        const found = await entry(path);
        if (found.kind !== "file") throw new GitFilesystemError("EISDIR", path);
        const bytes = await filesystem.readFile(path);
        if (!bytes) throw new GitFilesystemError("ENOENT", path);
        const format = typeof encoding === "string" ? encoding : encoding?.encoding;
        return format ? new TextDecoder().decode(bytes) : bytes;
      },
      async writeFile(path, data) {
        const existing = await filesystem.lookup(path);
        if (existing && existing.kind !== "file") throw new GitFilesystemError("ENOTSUP", path);
        await directory(path.slice(0, path.lastIndexOf("/")) || "/");
        await filesystem.writeFile(path, data);
      },
      async unlink(path) {
        const found = await entry(path);
        if (found.kind !== "file") throw new GitFilesystemError("EISDIR", path);
        await filesystem.remove(path);
      },
      async readdir(path) {
        return Array.from((await directory(path)).children.keys());
      },
      async mkdir(path) {
        if (await filesystem.lookup(path)) throw new GitFilesystemError("EEXIST", path);
        await directory(path.slice(0, path.lastIndexOf("/")) || "/");
        await filesystem.mkdirp(path);
      },
      async rmdir(path) {
        if ((await directory(path)).children.size) throw new GitFilesystemError("ENOTEMPTY", path);
        await filesystem.remove(path);
      },
      stat,
      lstat: stat,
      async readlink(path) {
        throw new GitFilesystemError("ENOTSUP", path);
      },
      async symlink(_target, path) {
        throw new GitFilesystemError("ENOTSUP", path);
      },
    },
  };
}
