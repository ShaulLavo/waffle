import type { Runtime } from "waffle";
import type { GitInstallation, GitInvocation } from "./git-types";
export type { GitInstallation, GitInvocation } from "./git-types";
const installed = new WeakSet<Runtime>();

/** Borrow the page's filesystem. Load the local Git core on the first command.
 * This is the in-page API; `installGitProgram` puts the same backend on PATH as `/usr/bin/git`.
 */
export async function installGit(runtime: Runtime): Promise<GitInstallation> {
  if (runtime.disposed) throw new Error("Runtime is disposed");
  if (installed.has(runtime)) throw new Error("Git is already installed on this Runtime");
  installed.add(runtime);
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let backend: Promise<typeof import("../dist/git-command.js")> | undefined;
  let filesystem: Promise<typeof import("./git-filesystem")> | undefined;
  let disposal: Promise<void> | undefined;
  const execute = async (invocation: GitInvocation) => {
    if (runtime.disposed) throw new Error("Runtime is disposed");
    backend ??= import("../dist/git-command.js");
    filesystem ??= import("./git-filesystem");
    const [command, adapter] = await Promise.all([backend, filesystem]);
    return command.runGit(adapter.gitFilesystem(runtime.filesystem), invocation);
  };
  return {
    run(invocation) {
      if (closed) return Promise.reject(new Error("Git installation is disposed"));
      const snapshot = { ...invocation, argv: invocation.argv.slice(), env: { ...invocation.env } };
      const result = tail.then(() => execute(snapshot));
      tail = result.catch(() => {});
      return result;
    },
    dispose() {
      closed = true;
      disposal ??= tail.then(() => {
        installed.delete(runtime);
      });
      return disposal;
    },
  };
}
