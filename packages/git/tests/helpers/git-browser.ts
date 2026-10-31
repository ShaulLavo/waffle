import { testSharedMemory } from "../../../waffle/tests/fixtures/shared-memory-platform.js";
import { createRuntime, type Runtime } from "waffle";
import { installGit } from "../../src/git";
import { gitFilesystem } from "../../src/git-filesystem";
import type { GitInstallation } from "../../src/git-types";
import type { GitLocalState } from "../../scripts/record-git-local";
import { mixedConflict, indexOnlyStash, type GitReviewRepository } from "./git-review-cases";
import { captureGit } from "./git-output";

let runtime: Runtime | undefined;
let installation: GitInstallation | undefined;
let admissions = 0;

function owner() {
  if (!runtime) throw new Error("Git test runtime is not initialized");
  return runtime;
}

function reviewRepository(dir: string, env: Record<string, string>): GitReviewRepository {
  return {
    async run(argv) {
      if (!installation) throw new Error("Git is not installed");
      return captureGit(installation.run, { argv, cwd: dir, env });
    },
    write: (path, text) => owner().filesystem.writeFile(`${dir}/${path}`, text),
    async remove(path) {
      await owner().filesystem.remove(`${dir}/${path}`);
    },
    async read(path) {
      const bytes = await owner().filesystem.readFile(`${dir}/${path}`);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    async blob(ref, path) {
      const { gitBlob } = await import("./git-blob");
      return gitBlob(gitFilesystem(owner().filesystem), dir, ref, path);
    },
  };
}

const api = {
  async setup() {
    runtime = createRuntime({
      sharedMemory: testSharedMemory,
      filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
      onProcessAdmission() {
        admissions++;
      },
    });
    installation = await installGit(runtime);
    return { admissions, disposed: runtime.disposed };
  },
  async repository(dir: string) {
    await owner().filesystem.mkdirp(dir);
  },
  async run(argv: readonly string[], cwd: string, env: Record<string, string>) {
    if (!installation) throw new Error("Git is not installed");
    return captureGit(installation.run, { argv, cwd, env });
  },
  async write(path: string, value: string) {
    await owner().filesystem.writeFile(path, value);
  },
  async remove(path: string) {
    await owner().filesystem.remove(path);
  },
  async snapshot(
    dir: string,
    expected: Readonly<Record<string, GitLocalState["history"][string] | undefined>>,
  ) {
    const { gitSnapshot } = await import("./git-snapshot");
    return gitSnapshot(gitFilesystem(owner().filesystem), dir, expected);
  },
  async reviewRegressions(env: Record<string, string>) {
    await owner().filesystem.mkdirp("/review-merge");
    await owner().filesystem.mkdirp("/review-stash");
    return {
      merge: await mixedConflict(reviewRepository("/review-merge", env)),
      stash: await indexOnlyStash(reviewRepository("/review-stash", env)),
    };
  },
  async release() {
    if (!installation) throw new Error("Git is not installed");
    const current = installation;
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const invocation = {
      argv: ["--version"],
      cwd: "/",
      stdout: async () => {
        entered.resolve();
        await gate.promise;
      },
      stderr() {},
    };
    const accepted = current.run(invocation);
    await entered.promise;
    const disposal = current.dispose();
    let joined = false;
    void disposal.then(() => {
      joined = true;
    });
    let admissionRejected = false;
    try {
      await current.run(invocation);
    } catch {
      admissionRejected = true;
    }
    const pendingOutputJoined = !joined;
    const disposalShared = current.dispose() === disposal;
    gate.resolve();
    const acceptedStatus = await accepted;
    await disposal;
    installation = await installGit(owner());
    await installation.dispose();
    const disposed = owner().disposed;
    await owner().filesystem.writeFile("/caller-still-live", "yes");
    return {
      runtimeDisposed: disposed,
      admissions,
      marker: (await owner().filesystem.readFile("/bin/git")) !== undefined,
      admissionRejected,
      pendingOutputJoined,
      disposalShared,
      acceptedStatus,
      reinstall: true,
    };
  },
  async cleanup() {
    await installation?.dispose();
    await runtime?.dispose();
    installation = undefined;
    runtime = undefined;
  },
};

declare global {
  interface Window {
    gitLocalTest: typeof api;
  }
}
window.gitLocalTest = api;
