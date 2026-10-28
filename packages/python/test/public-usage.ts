import type { Runtime } from "waffle";
import assert from "../../../tools/test-assert.ts";
import type { TestExecution, TestRequest } from "../../../tools/program-test-root.ts";
import { PYTHON_ARGV0 } from "@waffle/python";
import { publicUsageCases, publicUsageSources, type PublicUsageCase } from "./cases.ts";

type UsageRoot = {
  exec(request: TestRequest & { readonly input?: string }): Promise<TestExecution>;
};
type Launch = { argv: string[]; cwd: string; env: Record<string, string> };

async function seed(runtime: Runtime, example: PublicUsageCase, cwd: string) {
  const files: Record<string, string> = { ...example.files };
  if (example.kind === "script") {
    const source = publicUsageSources[example.script];
    if (source === undefined) throw new Error(`Missing Python source: ${example.script}`);
    files[example.script] = source;
  }
  await runtime.filesystem.mkdirp(cwd);
  for (const [name, contents] of Object.entries(files)) {
    const path = `${cwd}/${name}`;
    await runtime.filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
    await runtime.filesystem.writeFile(path, contents);
  }
}

function checkResult(example: PublicUsageCase, actual: TestExecution) {
  assert.equal(actual.status, example.status, example.name);
  assert.equal(actual.stdout, example.stdout, `${example.name}: stdout`);
  if (example.stderr !== undefined)
    assert.equal(actual.stderr, example.stderr, `${example.name}: stderr`);
  if (example.stderrIncludes !== undefined)
    assert.equal(actual.stderr.includes(example.stderrIncludes), true, `${example.name}: stderr`);
}

export async function qualifyPublicUsage(
  runtime: Runtime,
  root: UsageRoot,
  launches: readonly Launch[],
  examples: readonly PublicUsageCase[] = publicUsageCases,
) {
  const results: Array<{ name: string } & TestExecution> = [];
  for (const example of examples) {
    const cwd = example.cwd ?? "/home/guest";
    await seed(runtime, example, cwd);
    const argv = ["python"].concat(example.kind === "script" ? [example.script] : example.args);
    const env = {
      PATH: "/usr/bin:/bin",
      PWD: "/stale-directory",
      PYTHONDONTWRITEBYTECODE: "1",
      LC_ALL: "C.UTF-8",
      TOKEN: "preserved",
    };
    const originalEnv = JSON.stringify(env);
    const actual = await root.exec({
      executable: "/usr/bin/python",
      argv,
      cwd,
      env,
      input: example.input,
    });
    checkResult(example, actual);
    assert.equal(JSON.stringify(env), originalEnv, `${example.name}: caller env mutated`);
    const launched = launches.at(-1);
    if (!launched) throw new Error("Missing Python launch");
    assert.equal(launched.cwd, cwd, `${example.name}: cwd`);
    assert.equal(launched.env.PWD, cwd, `${example.name}: PWD`);
    assert.equal(launched.env.TOKEN, "preserved", `${example.name}: caller env`);
    assert.deepEqual(launched.argv, [PYTHON_ARGV0].concat(argv.slice(1)), `${example.name}: argv`);
    results.push({ name: example.name, ...actual });
  }
  return results;
}
