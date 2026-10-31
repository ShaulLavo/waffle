import { testSharedMemory } from "../../../waffle/tests/fixtures/shared-memory-platform.js";
import { createRuntime, type Runtime } from "waffle";
import { FilesystemClient } from "waffle/fs/client";
import { installGitProgram } from "../../src/program";

/** Dev-only: dispose removes only the script it created, never a caller's replacement. */
const source = "console.log('git');\n";

async function symlink(runtime: Runtime, path: string, target: string) {
  const client = new FilesystemClient(runtime.filesystem.fork());
  try {
    const slash = path.lastIndexOf("/");
    const directory = await client.asyncCall("preopen", [path.slice(0, slash) || "/"]);
    const resolved = await client.asyncCall("resolve", [directory, path.slice(slash + 1), false]);
    const errno = await client.asyncCall("symlink", [resolved, target]);
    if (errno) throw new Error(`symlink ${path}: errno ${errno}`);
  } finally {
    client.dispose();
  }
}

const moved = (path: string) => `/opt/${path.slice(path.lastIndexOf("/") + 1)}`;

type Replace = (runtime: Runtime, path: string) => Promise<void>;
const cases: Record<string, Replace | undefined> = {
  untouched: undefined,
  "moved script behind a symlink": async (runtime, path) => {
    await runtime.filesystem.mkdirp("/opt");
    await runtime.filesystem.move(path, moved(path));
    await symlink(runtime, path, moved(path));
  },
  "new file with identical bytes": async (runtime, path) => {
    const bytes = await runtime.filesystem.readFile(path);
    await runtime.filesystem.remove(path);
    await runtime.filesystem.writeFile(path, bytes!);
  },
  directory: async (runtime, path) => {
    await runtime.filesystem.remove(path);
    await runtime.filesystem.mkdirp(path);
  },
  "changed bytes": (runtime, path) => runtime.filesystem.writeFile(path, "caller\n"),
};

async function entries(runtime: Runtime, path: string) {
  const entry = await runtime.filesystem.lookup(path);
  const target = await runtime.filesystem.lookup(moved(path));
  return { entry: entry?.kind ?? null, optTarget: target?.kind ?? null };
}

Reflect.set(globalThis, "gitDispose", async () => {
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) },
  });
  const results: Record<string, unknown> = {};
  try {
    let index = 0;
    for (const [name, replace] of Object.entries(cases)) {
      const path = `/usr/bin/git-${index++}`;
      const installation = await installGitProgram(runtime, { source, path });
      await replace?.(runtime, path);
      await installation.dispose();
      await installation.dispose();
      results[name] = await entries(runtime, path);
    }
    return { ok: true, results };
  } catch (error) {
    return {
      ok: false,
      results,
      error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    };
  } finally {
    await runtime.dispose();
  }
});
