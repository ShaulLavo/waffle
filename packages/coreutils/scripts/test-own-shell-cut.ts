import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { resolve } from "node:path";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import { cutTrRecording } from "../tests/helpers/cut-tr-recording.ts";
import type * as Api from "./waffle-node-api.ts";

const { environment: env, cases } = cutTrRecording();
const nodeDirectory = new URL("../.build/node/", import.meta.url);
const directory = resolve(
  import.meta.dirname,
  "../../..",
  process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
  "wasm32-wasip1/release",
);
const rootOptions = { modulePath: "", tmp: "/tmp/spec", env, fixtureDirectory: directory };
const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const programs = {
  cut: {
    version: "0.13.0",
    install: api.installCut,
    bytes: new Uint8Array(await readFile(resolve(directory, "cut.wasm"))),
  },
};

async function fixture(context: TestContext) {
  installNodeWorkers();
  const admitted = Promise.withResolvers<number>();
  const admissions: string[] = [];
  const runtime = api.createRuntime({
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
    onProcessAdmission(event) {
      admissions.push(event.stage);
      if (event.stage === "launched") admitted.resolve(event.pid);
    },
  });
  context.after(async () => {
    await runtime.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  });
  for (const path of ["/tmp/spec", "/bin"]) await runtime.filesystem.mkdirp(path);
  return { runtime, admitted: admitted.promise, admissions };
}

async function execute(state: Awaited<ReturnType<typeof fixture>>, script: string) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  await state.runtime.filesystem.drain();
  const status = await runRoot(
    state.runtime,
    api,
    shell,
    rootOptions,
    script,
    (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
    () => {},
  );
  return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function install(state: Awaited<ReturnType<typeof fixture>>) {
  for (const program of Object.values(programs))
    await program.install(state.runtime, {
      source: program.bytes,
      workerUrl: new URL("shell.mjs", nodeDirectory),
    });
}

const name = "cut";
const program = programs.cut;
test(
  `${name} enters Waffle as lazy ordinary source and disposes independently`,
  { timeout: 15000 },
  async (context) => {
    const state = await fixture(context);
    let loads = 0;
    const installed = await program.install(state.runtime, {
      workerUrl: new URL("shell.mjs", nodeDirectory),
      source: () => {
        loads++;
        return program.bytes;
      },
    });
    assert.equal(loads, 0);
    assert.equal(state.admissions.length, 0);
    const actual = await execute(state, `${name} --version; ${name} --help`);
    assert.equal(actual.status, 0, actual.stderr.toString());
    assert.ok(actual.stdout.toString().includes(program.version));
    assert.equal(loads, 1);
    assert.ok(state.admissions.includes("launched"));
    await installed.dispose();
    await installed.dispose();
    assert.equal(await state.runtime.filesystem.lookup(`/bin/${name}`), undefined);
    assert.equal((await execute(state, name)).status, 127);
    const again = await program.install(state.runtime, {
      source: program.bytes,
      workerUrl: new URL("shell.mjs", nodeDirectory),
    });
    assert.equal((await execute(state, `${name} --version`)).status, 0);
    await again.dispose();
  },
);

for (const { name, script, ...expected } of cases.filter(({ name }) => name.startsWith("cut "))) {
  test(`cut matches GNU bytes and status for ${name}`, { timeout: 15000 }, async (context) => {
    const state = await fixture(context);
    await install(state);
    const actual = await execute(state, script);
    assert.equal(actual.status, expected.status, actual.stderr.toString());
    assert.deepEqual(actual.stdout, Buffer.from(expected.stdoutBase64, "base64"));
    assert.equal(actual.stderr.length > 0, expected.stderrPresent);
  });
}

test(`${name} can be interrupted and the shell recovers`, { timeout: 15000 }, async (context) => {
  const state = await fixture(context);
  await install(state);
  const command = "cut -b1-";
  const pending = execute(state, `while printf x; do :; done | ${command}`);
  const pid = await state.admitted;
  await setTimeout(25);
  await (await state.runtime.processes()).kill(pid, 2);
  assert.equal((await pending).status, 130);
  const recovery = "printf 'a:b\\n' | cut -d: -f2";
  const recovered = await execute(state, recovery);
  assert.equal(recovered.status, 0);
  assert.equal(recovered.stdout.toString(), "b\n");
});
