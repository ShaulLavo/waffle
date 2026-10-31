import { createRuntime, type Runtime } from "waffle";
import { installBunAdapters } from "bun-wasm";
import { installGit } from "waffle-git";
import { installGitProgram, GIT_CLI_URL } from "waffle-git/program";
import type { GitInvocation } from "../../src/git-types";
import { processRoot, type Result } from "./process-root";

/** Dev-only harness. Production code under src/ never imports Bash or this file. */
const steps: { mode: string; argv: readonly string[]; result: Result }[] = [];
const env = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.invalid",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : null);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** The six commands plus failure checks, against any `git` runner on one Runtime. */
async function scenario(
  runtime: Runtime,
  mode: string,
  dir: string,
  git: (argv: readonly string[], cwd: string) => Promise<Result>,
) {
  const fs = runtime.filesystem;
  const run = async (...argv: string[]) => {
    const result = await git(argv, dir);
    steps.push({ mode, argv, result });
    return result;
  };
  const ok = async (...argv: string[]) => {
    const result = await run(...argv);
    check(
      result.status === 0,
      `${mode} git ${argv.join(" ")} -> ${result.status}: ${result.stderr}`,
    );
    return result.stdout;
  };
  await fs.mkdirp(dir);
  await ok("init", "-b", "main");
  check((await fs.lookup(`${dir}/.git/HEAD`))?.kind === "file", "init wrote .git/HEAD");
  await fs.writeFile(`${dir}/story.txt`, "first line\n");
  await ok("add", "story.txt");
  const index = await fs.readFile(`${dir}/.git/index`);
  check(index && index.byteLength > 0, "add persisted .git/index");
  check((await ok("status")) === "A  story.txt\n", "status after add");
  await ok("commit", "-m", "First commit");
  const log = await ok("log");
  const head = /^commit ([0-9a-f]{40})\n/.exec(log)?.[1] ?? "";
  check(
    log ===
      `commit ${head}\nAuthor: Ada <ada@example.invalid>\nDate:   Tue Nov 14 22:13:20 2023 +0000\n\n    First commit\n`,
    `log author/date/message: ${log}`,
  );
  check(
    (await fs.lookup(`${dir}/.git/objects/${head.slice(0, 2)}/${head.slice(2)}`))?.kind === "file",
    "commit object persisted",
  );
  check((await ok("status")) === "", "clean after commit");
  await fs.writeFile(`${dir}/story.txt`, "first line\nsecond line\n");
  const diff = await ok("diff");
  check(
    diff.includes("--- a/story.txt\n+++ b/story.txt\n") && diff.includes("+second line\n"),
    `diff: ${diff}`,
  );
  // A failed command must not touch the index or worktree.
  const indexBefore = await fs.readFile(`${dir}/.git/index`);
  const commitFailure = await run("commit");
  check(
    commitFailure.status !== 0 && commitFailure.stderr.includes("git:"),
    "commit without -m fails",
  );
  const switchFailure = await run("switch", "missing");
  check(switchFailure.status !== 0, "switch to a missing branch fails");
  check(
    text(await fs.readFile(`${dir}/.git/index`)) === text(indexBefore),
    "failed commands kept the index",
  );
  check(
    text(await fs.readFile(`${dir}/story.txt`)) === "first line\nsecond line\n",
    "failed commands kept the worktree",
  );
  await ok("add", "story.txt");
  await ok("commit", "-m", "Second line");
  await ok("branch", "feature");
  check((await ok("branch")) === "  feature\n* main\n", "branch list");
  await ok("switch", "feature");
  check((await ok("branch")) === "* feature\n  main\n", "switched to feature");
  await fs.writeFile(`${dir}/feature.txt`, "on feature\n");
  await ok("add", "feature.txt");
  await ok("commit", "-m", "Feature work");
  await ok("switch", "-c", "topic");
  check((await ok("branch")) === "  feature\n  main\n* topic\n", "switch -c created topic");
  await ok("switch", "main");
  check((await fs.lookup(`${dir}/feature.txt`)) === undefined, "main has no feature file");
  const history = await ok("log", "--oneline", "feature");
  check(history.split("\n").filter(Boolean).length === 3, `feature history: ${history}`);
  return { head, history };
}

async function direct(runtime: Runtime) {
  const installation = await installGit(runtime);
  try {
    return await scenario(runtime, "api", "/work/api", (argv, cwd) =>
      capture((invocation) => installation.run(invocation), argv, cwd),
    );
  } finally {
    await installation.dispose();
  }
}

async function capture(
  run: (invocation: GitInvocation) => Promise<number>,
  argv: readonly string[],
  cwd: string,
): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const status = await run({
    argv,
    cwd,
    env,
    stdout: (bytes) => void (stdout += decoder.decode(bytes)),
    stderr: (bytes) => void (stderr += decoder.decode(bytes)),
  });
  return { status, stdout, stderr };
}

async function program(runtime: Runtime) {
  const bun = await installBunAdapters(runtime, {
    workerUrl: new URL("./worker.js", location.href),
    engine: "browser",
    wasmUrl: new URL("./bun.wasm", location.href),
    executables: ["/bin/bun"],
  });
  const git = await installGitProgram(runtime, {
    source: await (await fetch(GIT_CLI_URL)).text(),
  });
  const root = await processRoot(runtime, env);
  try {
    const result = await scenario(runtime, "program", "/work/cli", root.spawn);
    // The same objects are readable by the in-page API backend: one repository format, one backend.
    const api = await installGit(runtime);
    try {
      const crossed = await capture(
        (invocation) => api.run(invocation),
        ["log", "--oneline", "feature"],
        "/work/cli",
      );
      check(crossed.stdout === result.history, "API reads the program's repository");
    } finally {
      await api.dispose();
    }
    return { ...result, script: (await runtime.filesystem.readFile("/usr/bin/git"))?.byteLength };
  } finally {
    await root.dispose();
    await git.dispose();
    check(
      (await runtime.filesystem.lookup("/usr/bin/git")) === undefined,
      "dispose removed the owned script",
    );
    bun.dispose();
  }
}

Reflect.set(globalThis, "gitSix", async () => {
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) },
  });
  const started = performance.now();
  await runtime.filesystem.writeFile("/caller-data", "keep Git caller data");
  try {
    const api = await direct(runtime);
    const apiMs = performance.now() - started;
    const cli = await program(runtime);
    check(api.head === cli.head, "API and CLI commit objects differ");
    check(
      text(await runtime.filesystem.readFile("/caller-data")) === "keep Git caller data",
      "Git disposal removed caller data",
    );
    return { ok: true, api, cli, apiMs, totalMs: performance.now() - started, steps };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
      steps,
    };
  } finally {
    await runtime.dispose();
    document.body.dataset.disposed = String(runtime.disposed);
  }
});
