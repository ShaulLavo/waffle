import { testSharedMemory } from "../../../waffle/tests/fixtures/shared-memory-platform.js";
import { createRuntime, type Runtime } from "waffle";
import { installBunAdapters } from "bun-wasm";
import { createShell, SharedBridge, control } from "bash-web";
import { installGit } from "../../src/git";
import { installGitProgram } from "../../src/program";
import { processRoot } from "./process-root";

/** Dev-only harness: the shell and Bun find `git` by name on PATH=/usr/bin:/bin.
 * Bash is test composition here; src/ never imports it.
 */
const identity = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.invalid",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const env = { ...identity, PATH: "/usr/bin:/bin", HOME: "/home/user" };
const decoder = new TextDecoder();
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function sharedRepository(runtime: Runtime) {
  const git = await installGit(runtime);
  const run = (...argv: string[]) =>
    git.run({ argv, cwd: "/work/shared", env: identity, stdout: () => {}, stderr: () => {} });
  try {
    await runtime.filesystem.mkdirp("/work/shared");
    await runtime.filesystem.writeFile("/work/shared/notes.txt", "shared\n");
    for (const argv of [
      ["init", "-b", "main"],
      ["add", "notes.txt"],
      ["commit", "-m", "Shared commit"],
    ])
      check((await run(...argv)) === 0, `seed git ${argv.join(" ")}`);
  } finally {
    await git.dispose();
  }
}

// Plain cwd, not -C: `cd` sets the shell's cwd and children inherit it.
const bashScript = `cd /work/shared
command -v git
git log --format=%s
echo "log=$?"
subject=$(git log -n 1 --format=%s)
echo "subject=[$subject]"
cd /work
git init -b main bashrepo
echo "init=$?"
git status
echo "status=$?"
`;

async function viaBash(runtime: Runtime) {
  const terminal = new SharedBridge();
  Atomics.store(terminal.state, control.cols, 120);
  Atomics.store(terminal.state, control.rows, 24);
  const shell = await createShell({
    runtime,
    script: bashScript,
    cwd: "/home/user",
    env,
    terminal,
    wasmUrl: new URL("./shell-engine.wasm", location.href),
    workerUrl: new URL("./shell-worker.js", location.href),
  });
  let screen = "";
  let finished = false;
  void shell.done.finally(() => (finished = true));
  try {
    const deadline = performance.now() + 60_000;
    while (!finished) {
      check(performance.now() < deadline, `shell deadline: ${screen}`);
      screen += decoder.decode(terminal.drain());
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    screen += decoder.decode(terminal.drain());
    return { exit: (await shell.done).code, screen };
  } finally {
    await shell.dispose();
  }
}

const bunScript = `const env = { PATH: "/usr/bin:/bin", HOME: "/home/user" };
async function run(argv, cwd) {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { argv, cwd, status, stdout, stderr };
}
const results = [];
results.push(await run(["git", "log", "--format=%s"], "/work/shared"));
results.push(await run(["git", "init", "-b", "main", "bunrepo"], "/work"));
results.push(await run(["git", "status"], "/work"));
console.log(JSON.stringify(results));
`;

async function viaBun(runtime: Runtime) {
  await runtime.filesystem.writeFile("/work/spawn.mjs", bunScript);
  const root = await processRoot(runtime, env);
  try {
    return await root.spawn(["/work/spawn.mjs"], "/work", "/bin/bun");
  } finally {
    root.dispose();
  }
}

async function head(runtime: Runtime, dir: string) {
  return decoder.decode(
    (await runtime.filesystem.readFile(`${dir}/.git/HEAD`)) ?? new Uint8Array(),
  );
}

Reflect.set(globalThis, "gitLookup", async () => {
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) },
  });
  const started = performance.now();
  const result: Record<string, unknown> = {};
  try {
    const bun = await installBunAdapters(runtime, {
      workerUrl: new URL("./worker.js", location.href),
      engine: "browser",
      wasmUrl: new URL("./bun.wasm", location.href),
      executables: ["/bin/bun"],
    });
    const git = await installGitProgram(runtime, {
      source: await (await fetch("./git-cli.js")).text(),
    });
    try {
      await sharedRepository(runtime);
      result.bash = await viaBash(runtime);
      result.bun = await viaBun(runtime);
      result.heads = {
        bash: await head(runtime, "/work/bashrepo"),
        bun: await head(runtime, "/work/bunrepo"),
      };
    } finally {
      await git.dispose();
      bun.dispose();
    }
    return { ok: true, ...result, ms: performance.now() - started };
  } catch (error) {
    return {
      ok: false,
      ...result,
      error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    };
  } finally {
    await runtime.dispose();
  }
});
