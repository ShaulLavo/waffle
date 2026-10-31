import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import { cutTrRecording } from "../tests/helpers/cut-tr-recording.ts";
import { trCases } from "../tests/helpers/tr-cases.ts";
import type * as Api from "./waffle-node-api.ts";

const workerRoot = new URL("../.build/node/", import.meta.url);
const release = resolve(
  import.meta.dirname,
  "../../..",
  process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
  "wasm32-wasip1/release",
);
const api: typeof Api = await import(new URL("api.mjs", workerRoot).href);
const guest = new Uint8Array(await readFile(resolve(release, "tr.wasm")));
const shellModule = await WebAssembly.compile(
  await readFile(resolve(release, "shell-runtime.wasm")),
);

test("tr ordinary-source qualification", { timeout: 60000 }, async (context) => {
  installNodeWorkers();
  const launched: number[] = [];
  const runtime = api.createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { workerURL: new URL("fs.mjs", workerRoot), mode: "memory" },
    onProcessAdmission(event) {
      if (event.stage === "launched") launched.push(event.pid);
    },
  });
  context.after(async () => {
    await runtime.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0, "runtime disposal releases every worker");
  });
  await runtime.filesystem.mkdirp("/tmp/spec");
  const workerUrl = new URL("shell.mjs", workerRoot);
  const options = {
    modulePath: "",
    tmp: "/tmp/spec",
    fixtureDirectory: release,
    env: cutTrRecording().environment,
  };
  async function execute(script: string) {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    await runtime.filesystem.drain();
    const status = await runRoot(
      runtime,
      api,
      shellModule,
      options,
      script,
      (fd, bytes) => (fd === 2 ? err : out).push(Buffer.from(bytes)),
      () => {},
    );
    return { status, out: Buffer.concat(out), err: Buffer.concat(err) };
  }
  let loads = 0;
  const installed = await api.installTr(runtime, {
    workerUrl,
    source: () => {
      loads++;
      return guest;
    },
  });
  assert.equal(loads, 0);
  assert.equal(launched.length, 0);
  const version = await execute("tr --version; tr --help");
  assert.equal(version.status, 0, version.err.toString());
  assert.match(version.out.toString(), /0\.13\.0/);
  assert.equal(loads, 1);
  assert.equal(launched.length, 2);
  await api.installCut(runtime, {
    workerUrl,
    source: new Uint8Array(await readFile(resolve(release, "cut.wasm"))),
  });
  for (const entry of trCases()) {
    await context.test(entry.name, async () => {
      const result = await execute(entry.script);
      assert.equal(result.status, entry.status, result.err.toString());
      assert.deepEqual(result.out, Buffer.from(entry.stdoutBase64, "base64"));
      assert.equal(result.err.length > 0, entry.stderrPresent);
    });
  }
  const count = launched.length;
  const pending = execute("while printf x; do :; done | tr a-z A-Z > /tmp/tr-interrupted");
  while (launched.length === count) await setTimeout(1);
  const service = await runtime.processes();
  await service.kill(launched[count], 2);
  assert.equal((await pending).status, 130);
  const recovered = await execute("printf b | tr a-z A-Z");
  assert.equal(recovered.status, 0);
  assert.equal(recovered.out.toString(), "B");
  await installed.dispose();
  await installed.dispose();
  assert.equal(await runtime.filesystem.lookup("/bin/tr"), undefined);
  assert.equal((await execute("tr")).status, 127);
  assert.equal((await execute("printf a:b | cut -d: -f2")).out.toString(), "b\n");
  const again = await api.installTr(runtime, { workerUrl, source: guest });
  assert.equal((await execute("tr --version")).status, 0);
  await again.dispose();
});
