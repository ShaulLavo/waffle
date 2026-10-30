import { mkdir, readFile, writeFile } from "node:fs/promises";
import { GhError } from "./errors.ts";
import type { FileSystem, Invocation } from "./types.ts";

export const nodeFileSystem: FileSystem = {
  async readFile(path) {
    try {
      return await readFile(path);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return undefined;
      throw error;
    }
  },
  async writeFile(path, contents, mode) {
    await writeFile(path, contents, { mode });
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
};

export function resolvePath(cwd: string, path: string): string {
  const parts = (path.startsWith("/") ? path : `${cwd}/${path}`).split("/");
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return `/${result.join("/")}`;
}

export async function readRequired(invocation: Invocation, path: string): Promise<Uint8Array> {
  if (path === "-") return invocation.stdin();
  const contents = await invocation.filesystem.readFile(resolvePath(invocation.cwd, path));
  if (!contents) throw new GhError(`could not read file: ${path}`);
  return contents;
}
