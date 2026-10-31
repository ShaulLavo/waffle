import { testSharedMemory } from "../../../waffle/tests/fixtures/shared-memory-platform.js";
import { createRuntime, type Runtime } from "waffle";
import { installBunAdapters, type BunAdapterInstallation } from "bun-wasm";
import { installGit, type GitInstallation } from "waffle-git";
import { GIT_CLI_URL, installGitProgram, type GitProgramInstallation } from "waffle-git/program";
import { captureGit } from "../helpers/git-output";
import { processRoot, type Result } from "./process-root";

const env = {
  GIT_AUTHOR_NAME: "Revision test",
  GIT_AUTHOR_EMAIL: "revision@example.invalid",
  GIT_COMMITTER_NAME: "Revision test",
  GIT_COMMITTER_EMAIL: "revision@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const directory = "/repo space/é";
const nested = `${directory}/nested space/ישראל`;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function snapshot(runtime: Runtime, path: string): Promise<string[]> {
  const entry = await runtime.filesystem.lookup(path);
  check(entry, `missing snapshot path ${path}`);
  if (entry.kind === "file")
    return [`${path}\0${Array.from((await runtime.filesystem.readFile(path)) ?? []).join(",")}`];
  check(entry.kind === "dir", `unexpected snapshot entry ${path}`);
  let rows: string[] = [];
  for (const name of Array.from(entry.children.keys()).sort())
    rows = rows.concat(await snapshot(runtime, `${path}/${name}`));
  return rows;
}

async function initialize(runtime: Runtime, api: GitInstallation) {
  await runtime.filesystem.mkdirp(nested);
  await runtime.filesystem.mkdirp("/outside");
  for (const argv of [
    ["init", "-b", "main"],
    ["commit", "--allow-empty", "-m", "base"],
    ["branch", "topic/é"],
  ]) {
    const result = await captureGit(api.run, { argv, cwd: directory, env });
    check(result.status === 0, JSON.stringify({ argv, result }));
  }
  const head = await captureGit(api.run, {
    argv: ["log", "-n", "1", "--format=%H"],
    cwd: directory,
    env,
  });
  check(head.status === 0 && /^[0-9a-f]{40}\n$/.test(head.stdout), "fixture commit missing");
  return head.stdout.trim();
}

function cases(oid: string): { argv: string[]; cwd: string; expected: Result }[] {
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
  return [
    {
      argv: ["HEAD", "refs/heads/main", "topic/é"],
      cwd: nested,
      expected: ok(`${oid}\n`.repeat(3)),
    },
    { argv: ["--verify", "HEAD"], cwd: nested, expected: ok(`${oid}\n`) },
    { argv: ["--short=8", "HEAD"], cwd: nested, expected: ok(`${oid.slice(0, 8)}\n`) },
    {
      argv: ["--show-toplevel", "--show-prefix", "--is-inside-work-tree"],
      cwd: nested,
      expected: ok(`${directory}\nnested space/ישראל/\ntrue\n`),
    },
    { argv: ["--show-prefix"], cwd: directory, expected: ok("\n") },
    {
      argv: ["--verify", "missing"],
      cwd: nested,
      expected: { status: 128, stdout: "", stderr: "fatal: Needed a single revision\n" },
    },
    {
      argv: ["--is-inside-work-tree"],
      cwd: "/outside",
      expected: {
        status: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      },
    },
    {
      argv: ["HEAD~1"],
      cwd: nested,
      expected: { status: 129, stdout: "", stderr: "git: unsupported revision syntax 'HEAD~1'\n" },
    },
  ];
}

Reflect.set(globalThis, "gitRevParseSmoke", async () => {
  let admissions = 0;
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) },
    onProcessAdmission() {
      admissions++;
    },
  });
  let api: GitInstallation | undefined;
  let bun: BunAdapterInstallation | undefined;
  let program: GitProgramInstallation | undefined;
  let root: Awaited<ReturnType<typeof processRoot>> | undefined;
  const results: { mode: string; argv: string[]; cwd: string; result: Result }[] = [];
  try {
    const installation = await installGit(runtime);
    api = installation;
    const oid = await initialize(runtime, installation);
    const before = JSON.stringify(await snapshot(runtime, directory));
    await checkQueries(
      "api",
      (argv, cwd) => captureGit(installation.run, { argv, cwd, env }),
      oid,
      results,
    );
    check(admissions === 0, "API revision queries admitted a process");
    bun = await installBunAdapters(runtime, {
      workerUrl: new URL("./worker.js", location.href),
      engine: "browser",
      wasmUrl: new URL("./bun.wasm", location.href),
      executables: ["/bin/bun"],
    });
    program = await installGitProgram(runtime, { source: await (await fetch(GIT_CLI_URL)).text() });
    root = await processRoot(runtime, env);
    await checkQueries("cli", root.spawn, oid, results);
    check(
      JSON.stringify(await snapshot(runtime, directory)) === before,
      "revision queries changed repository bytes",
    );
    return { ok: true, oid, results, repositoryUnchanged: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
      results,
    };
  } finally {
    await root?.dispose();
    await program?.dispose();
    bun?.dispose();
    await api?.dispose();
    await runtime.dispose();
    document.body.dataset.disposed = String(runtime.disposed);
  }
});

async function checkQueries(
  mode: string,
  run: (argv: readonly string[], cwd: string) => Promise<Result>,
  oid: string,
  results: { mode: string; argv: string[]; cwd: string; result: Result }[],
) {
  for (const { argv, cwd, expected } of cases(oid)) {
    const result = await run(["rev-parse"].concat(argv), cwd);
    results.push({ mode, argv, cwd, result });
    check(
      JSON.stringify(result) === JSON.stringify(expected),
      JSON.stringify({ mode, argv, expected, result }),
    );
  }
}
