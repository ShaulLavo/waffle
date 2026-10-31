import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fileUtilityCases,
  fileUtilityEnvironment,
  fileUtilityNames,
  initialTree,
} from "../tests/helpers/file-utility-cases.ts";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import { fileUtilityObservation } from "./file-utilities-observations.ts";
import { fileUtilityTree, seedFileUtilityTree } from "../tests/helpers/file-utility-filesystem.ts";
import type * as Api from "../tests/helpers/file-utilities-api.ts";

const api: typeof Api = await import(
  new URL("../.build/node/file-utilities-api.mjs", import.meta.url).href
);
const nodeDirectory = new URL("../.build/node/", import.meta.url);
const directory = resolve(
  import.meta.dirname,
  "../../..",
  process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
  "wasm32-wasip1/release",
);
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const installers = {
  touch: api.installTouch,
  rm: api.installRm,
  cp: api.installCp,
  mv: api.installMv,
};

async function fixture(context: TestContext) {
  installNodeWorkers();
  const runtime = api.createRuntime({
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
  });
  let stop = () => {};
  context.after(async () => {
    stop();
    await runtime.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  });
  await seedFileUtilityTree(runtime);
  for (const name of fileUtilityNames)
    await installers[name](runtime, {
      workerUrl: new URL("shell.mjs", nodeDirectory),
      source: new Uint8Array(await readFile(resolve(directory, `${name}.wasm`))),
    });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  async function run(script: string) {
    const status = await runRoot(
      runtime,
      api,
      shell,
      {
        modulePath: "",
        tmp: "/tmp/spec",
        env: fileUtilityEnvironment,
        fixtureDirectory: directory,
      },
      script,
      (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
      (terminate) => {
        stop = terminate;
      },
    );
    return {
      status,
      stdout: Array.from(Buffer.concat(stdout)),
      stderr: Buffer.concat(stderr).length > 0,
      tree: await fileUtilityTree(runtime),
    };
  }
  return { runtime, run, diagnostic: () => Buffer.concat(stderr).toString() };
}

for (const example of fileUtilityCases) {
  test(`WASI filesystem and GNU agree: ${example.name}`, { timeout: 15000 }, async (context) => {
    const expected = fileUtilityObservation(example.script);
    const state = await fixture(context);
    const actual = await state.run(example.script);
    assert.deepEqual(actual, expected, state.diagnostic());
  });
}

test(
  "Waffle synthetic metadata makes terminal mv prompt before replacement",
  { timeout: 15000 },
  async (context) => {
    const state = await fixture(context);
    const actual = await state.run("mv input existing");
    assert.deepEqual(actual, { status: 1, stdout: [], stderr: true, tree: initialTree });
    assert.equal(state.diagnostic(), "mv: overwrite 'existing'? ");
  },
);
