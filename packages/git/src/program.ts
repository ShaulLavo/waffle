import type { Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { FilesystemError } from "waffle/fs/protocol";

/** Bundler-visible URL for the prepared CLI script. */
export const GIT_CLI_URL = new URL("../dist/git-cli.js", import.meta.url);

export interface GitProgramOptions {
  /** The bundled `dist/git-cli.js` text. Callers fetch it from the package asset URL. */
  readonly source: string;
  /** A registered JavaScript interpreter on this Runtime, for example bun-wasm's `/bin/bun`. */
  readonly interpreter?: string;
  /** Absolute canonical program path. */
  readonly path?: string;
}

export interface GitProgramInstallation {
  readonly path: string;
  /** Remove the script only while it still holds the bytes this installation wrote. */
  dispose(): Promise<void>;
}

export class GitProgramConflictError extends Error {
  readonly code = "GIT_PROGRAM_CONFLICT";
  constructor(readonly path: string) {
    super(`Cannot install git: a different filesystem entry already exists at ${path}`);
    this.name = "GitProgramConflictError";
  }
}

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array) =>
  left !== undefined &&
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

/** Install `git` as an interpreter script on the Runtime's filesystem.
 * Waffle's shebang admission runs it with the caller's interpreter; no executable is registered here.
 */
export async function installGitProgram(
  runtime: Runtime,
  options: GitProgramOptions,
): Promise<GitProgramInstallation> {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  const path = options.path ?? "/usr/bin/git";
  const interpreter = options.interpreter ?? "/bin/bun";
  for (const name of [path, interpreter]) {
    if (
      !name.startsWith("/") ||
      name
        .slice(1)
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new TypeError(`Path must be absolute and canonical: ${name}`);
  }
  const bytes = new TextEncoder().encode(`#!${interpreter}\n${options.source}`);
  // Order after queued page writes, then use a private connection for exclusive creation.
  await runtime.filesystem.resolvePath("/");
  const filesystem = new FilesystemClient(runtime.filesystem.fork());
  let owned: number | undefined;
  try {
    await filesystem.asyncCall("mkdirp", [path.slice(0, path.lastIndexOf("/")) || "/"]);
    if (await createScript(filesystem, path, bytes))
      owned = (await filesystem.asyncCall("lookup", [path]))?.ino;
  } finally {
    filesystem.dispose();
  }
  let disposal: Promise<void> | undefined;
  return {
    path,
    dispose() {
      disposal ??=
        owned === undefined ? Promise.resolve() : removeOwned(runtime, path, owned, bytes);
      return disposal;
    },
  };
}

async function createScript(filesystem: FilesystemClient, path: string, bytes: Uint8Array) {
  try {
    await filesystem.asyncCall("writeFile", [path, false, true], bytes);
    return true;
  } catch (error) {
    if (!(error instanceof FilesystemError) || error.errno !== 20) throw error;
    // An identical script from an earlier install may be reused, but is not owned for deletion.
    const entry = await filesystem.asyncCall("lookup", [path]);
    if (entry?.kind !== "file" || !sameBytes(await filesystem.asyncCall("readFile", [path]), bytes))
      throw new GitProgramConflictError(path);
    return false;
  }
}

/** Lookup does not follow a final symlink: only the created regular file, unchanged, is removed.
 * Replacement symlinks, directories and files (even with identical bytes) are the caller's. */
async function removeOwned(runtime: Runtime, path: string, ino: number, bytes: Uint8Array) {
  if (runtime.disposed) return;
  const entry = await runtime.filesystem.lookup(path);
  if (entry?.kind !== "file" || entry.ino !== ino) return;
  if (!sameBytes(await runtime.filesystem.readFile(path), bytes)) return;
  await runtime.filesystem.remove(path);
}
