import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Runtime } from "waffle";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";

const waffle = (await import(
  new URL("../.build/node/api.mjs", import.meta.url).href
)) as typeof Api;
const directory = resolve(
  import.meta.dirname,
  "../../..",
  process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
  "wasm32-wasip1/release",
);
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const source = await readFile(resolve(directory, "ls.wasm"));
const files = { ".hidden": "secret\n", Alpha: "A", beta: "bb", "space name": "ccc", zeta: "" };
const env = { PATH: "/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" };

async function provision(runtime: Runtime) {
  for (const path of ["/listing/empty", "/listing/sub"]) await runtime.filesystem.mkdirp(path);
  for (const [name, contents] of Object.entries(files))
    await runtime.filesystem.writeFile(`/listing/${name}`, contents);
  await runtime.filesystem.writeFile("/listing/sub/child", "nested");
  await runtime.filesystem.drain();
}

async function run(script: string) {
  installNodeWorkers();
  const runtime = waffle.createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { mode: "memory", workerURL: new URL("../.build/node/fs.mjs", import.meta.url) },
  });
  const stderr: Buffer[] = [];
  let loads = 0;
  try {
    await provision(runtime);
    const installation = await waffle.installLs(runtime, {
      workerUrl: new URL("../.build/node/shell.mjs", import.meta.url),
      source: () => {
        loads++;
        return source;
      },
    });
    assert.equal(loads, 0, "installing ls loads no executable bytes");
    const status = await runRoot(
      runtime,
      waffle,
      shell,
      {
        tmp: "/listing",
        env,
        fixtureDirectory: "",
        modulePath: resolve(directory, "shell-runtime.wasm"),
      },
      script,
      (fd, bytes) => {
        if (fd === 2) stderr.push(Buffer.from(bytes));
      },
      () => {},
    );
    const stdout = Buffer.from((await runtime.filesystem.readFile("/result")) ?? []);
    await installation.dispose();
    assert.equal(await runtime.filesystem.lookup("/bin/ls"), undefined);
    return { stdout, stderr: Buffer.concat(stderr), status, loads };
  } finally {
    await runtime.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  }
}

const cases = [
  { name: "default cwd", args: "", stdout: "Alpha\nbeta\nempty\nspace name\nsub\nzeta\n" },
  {
    name: "hidden entries",
    args: "-a",
    stdout: ".\n..\n.hidden\nAlpha\nbeta\nempty\nspace name\nsub\nzeta\n",
  },
  { name: "single column", args: "-1", stdout: "Alpha\nbeta\nempty\nspace name\nsub\nzeta\n" },
  { name: "absolute directory", args: "/listing/sub", stdout: "child\n" },
  { name: "relative directory", args: "sub", stdout: "child\n" },
  { name: "file operands sorted", args: "zeta beta Alpha", stdout: "Alpha\nbeta\nzeta\n" },
  { name: "multiple directories sorted", args: "sub empty", stdout: "empty:\n\nsub:\nchild\n" },
  {
    name: "files before directories",
    args: "sub beta empty Alpha",
    stdout: "Alpha\nbeta\n\nempty:\n\nsub:\nchild\n",
  },
  { name: "list directory itself", args: "-d sub", stdout: "sub\n" },
];

for (const value of cases) {
  test(`upstream ls matches GNU fixture bytes: ${value.name}`, async () => {
    const result = await run(`ls ${value.args} > /result`);
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, Buffer.from(value.stdout));
    assert.equal(result.stderr.length, 0);
    assert.equal(result.loads, 1);
  });
}

test("upstream ls reports missing paths with status 2", async () => {
  const result = await run("ls absent > /result");
  assert.equal(result.status, 2);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.toString(), /ls: cannot access 'absent': No such file or directory/);
});

test("two ls spawns share one lazy source load and keep the caller cwd", async () => {
  const result = await run("ls -1 sub > /result; ls -1 sub >> /result");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), "child\nchild\n");
  assert.equal(result.loads, 1);
});

test("WASI long format exposes upstream metadata limitations", async () => {
  const result = await run("ls -l --time-style=+FIXED Alpha > /result");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), "-r-xr-xr-x 1 somebody somegroup 1 FIXED Alpha\n");
});
