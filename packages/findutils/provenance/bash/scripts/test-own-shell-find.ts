import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";
import {
  findCases,
  findOutput,
  findRejections,
  seedFindTree,
} from "../tests/helpers/find-cases.ts";
import { findOracle } from "./find-oracle.ts";

const nodeDirectory = new URL("../.build/node/", import.meta.url);
const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const find = new Uint8Array(await readFile(resolve(directory, "find.wasm")));
const env = { PATH: "/bin", HOME: "/home/user", LC_ALL: "C", LANG: "C", TZ: "UTC" };
type Runtime = ReturnType<typeof api.createRuntime>;

async function disposeFixture(runtime: Runtime, stop: () => void) {
  stop();
  try {
    await runtime.dispose();
  } finally {
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  }
}

async function fixture(context: TestContext, expanded = false) {
  installNodeWorkers();
  const runtime = api.createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("fs.mjs", nodeDirectory) },
  });
  let stop = () => {};
  context.after(() => disposeFixture(runtime, stop));
  if (expanded) await seedFindTree(runtime);
  else {
    for (const path of ["/tree/sub/deep", "/bin", "/home/user"])
      await runtime.filesystem.mkdirp(path);
    for (const [path, contents] of [
      ["/tree/a.txt", "a"],
      ["/tree/sub/b.txt", "b"],
      ["/tree/sub/deep/c.txt", "c"],
    ])
      await runtime.filesystem.writeFile(path, contents);
  }
  let loads = 0;
  const installation = await api.installFind(runtime, {
    workerUrl: new URL("shell.mjs", nodeDirectory),
    source: () => {
      loads++;
      return find;
    },
  });
  await runtime.filesystem.drain();

  async function run(script: string) {
    const stderr: Buffer[] = [];
    const status = await runRoot(
      runtime,
      api,
      shell,
      { modulePath: "", tmp: "/tree", env, fixtureDirectory: directory },
      script,
      (fd, bytes) => {
        if (fd === 2) stderr.push(Buffer.from(bytes));
      },
      (terminate) => {
        stop = terminate;
      },
    );
    const result = Buffer.from((await runtime.filesystem.readFile("/result")) ?? []);
    return {
      status,
      stdout: result,
      stderr: Buffer.concat(stderr),
    };
  }

  return { installation, loads: () => loads, run };
}

test("find traverses and matches the bounded initial scope", async (context) => {
  const state = await fixture(context);
  const cases = [
    ["find /tree -maxdepth 1 -type f -print", "/tree/a.txt\n"],
    ["find /tree -mindepth 2 -maxdepth 2 -name 'b*' -print", "/tree/sub/b.txt\n"],
    ["find /tree -name sub -prune -o -type f -print", "/tree/a.txt\n"],
    ["find /tree/sub/deep -type f -print0", "/tree/sub/deep/c.txt\0"],
  ] as const;
  for (const [script, expected] of cases) {
    const actual = await state.run(`${script} > /result`);
    assert.equal(actual.status, 0, script);
    assert.deepEqual(actual.stdout, Buffer.from(expected), script);
    assert.equal(actual.stderr.length, 0, script);
  }
});

test("find follows the shell cwd and loads once across spawns", async (context) => {
  const state = await fixture(context);
  assert.equal(state.loads(), 0);
  let actual = await state.run("cd /tree/sub; find . -maxdepth 1 -type f -print > /result");
  assert.equal(actual.status, 0);
  assert.deepEqual(actual.stdout, Buffer.from("./b.txt\n"));
  assert.equal(state.loads(), 1);
  actual = await state.run("find /tree/sub/deep -type f -print > /result");
  assert.equal(actual.status, 0);
  assert.deepEqual(actual.stdout, Buffer.from("/tree/sub/deep/c.txt\n"));
  assert.equal(state.loads(), 1);
});

test("find installation disposes its executable marker", async (context) => {
  const state = await fixture(context);
  await state.installation.dispose();
  const actual = await state.run("find /tree -type f");
  assert.equal(actual.status, 127);
});

for (const example of findCases) {
  test(`find matches GNU: ${example.name}`, async (context) => {
    const oracle = await findOracle(context);
    const expected = await oracle(example.script);
    const state = await fixture(context, true);
    const actual = await state.run(`cd /tree; { ${example.script}; } > /result`);
    assert.equal(actual.status, expected.status, actual.stderr.toString());
    assert.deepEqual(
      findOutput(actual.stdout, example.records, example.prefix),
      findOutput(expected.stdout, example.records, example.prefix),
    );
    assert.equal(actual.stderr.length > 0, expected.stderr.length > 0);
  });
}

test("find traversal guest has no child-process imports", async () => {
  const module = await WebAssembly.compile(find);
  assert.ok(
    WebAssembly.Module.imports(module).every((entry) => entry.module === "wasi_snapshot_preview1"),
  );
});

for (const example of findRejections) {
  test(
    `find rejects unsupported execution: ${example.name}`,
    { timeout: 10000 },
    async (context) => {
      const state = await fixture(context, true);
      const actual = await state.run(`cd /tree; { ${example.script}; } > /result`);
      assert.equal(actual.status, 1, actual.stderr.toString());
      assert.equal(actual.stdout.toString(), example.stdout);
      assert.ok(actual.stderr.toString().includes(example.diagnostic), actual.stderr.toString());
      assert.doesNotMatch(actual.stderr.toString(), /< .* > \? /);
      assert.doesNotMatch(actual.stderr.toString(), /No such file|Is a directory|zero-length/);
    },
  );
}
