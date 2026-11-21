import { expect, test } from "bun:test";
import {
  BrowserProcessBroker,
  type BrowserProcessBrokerOptions,
} from "../browser/process-broker.js";
import { startCommand } from "../proc/start-command.js";
import { createRuntime, type Runtime } from "../runtime.js";

const moduleBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const fsWorker = new URL("../browser/fs-worker.ts", import.meta.url);
const options = { filesystem: "runtime-root" } as const;

async function install(runtime: Runtime, launch: Parameters<Runtime["registerAdapter"]>[1]) {
  runtime.registerAdapter("control", launch);
  runtime.registerProgram("/fixture", { adapter: "control", source: moduleBytes });
  await runtime.filesystem.writeFile("/fixture", "");
}

test("kill drops an awaiting activation before it reserves any process", async () => {
  const deferred = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<BrowserProcessBrokerOptions>();
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: fsWorker },
    async processHost(options) {
      entered.resolve(options);
      await deferred.promise;
      return new BrowserProcessBroker(options);
    },
  });
  try {
    const command = startCommand(runtime, "/fixture", options);
    const { table } = await entered.promise;
    expect(command.kill()).toBe(command.result);
    expect(await command.result).toMatchObject({ exit: null, stopRequested: "kill" });
    expect(Array.from(table.values())).toEqual([]);
    await command.signal(2);
    deferred.resolve();
    await runtime.processes();
    expect(Array.from(table.values())).toEqual([]);
  } finally {
    deferred.resolve();
    await runtime.dispose();
  }
});

test("kill joins a late adapter handle and its physical stop", async () => {
  const entered = Promise.withResolvers<void>();
  const releaseLaunch = Promise.withResolvers<void>();
  const stopEntered = Promise.withResolvers<void>();
  const releaseStop = Promise.withResolvers<void>();
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: fsWorker } });
  try {
    await install(runtime, async (context) => {
      context.started();
      entered.resolve();
      await releaseLaunch.promise;
      return {
        async terminate() {
          stopEntered.resolve();
          await releaseStop.promise;
        },
      };
    });
    const command = startCommand(runtime, "/fixture", options);
    let done = false;
    void command.result.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await entered.promise;
    const end = command.kill();
    expect(end).toBe(command.result);
    await Bun.sleep(0);
    expect(done).toBe(false);
    releaseLaunch.resolve();
    await stopEntered.promise;
    expect(done).toBe(false);
    releaseStop.resolve();
    expect(await end).toMatchObject({
      exit: { kind: "signaled", code: 9, status: 137 },
      stopRequested: "kill",
    });
    const service = await runtime.processes();
    expect(Array.from((await service.ready()).table.values())).toEqual([]);
  } finally {
    releaseLaunch.resolve();
    releaseStop.resolve();
    await runtime.dispose();
  }
});

test("a real generic command Worker can start within the bounded runtime and exit 130", () => {
  // A fresh page ledger keeps backing retained by another test outside this budget.
  const entry = new URL("./fixtures/command-bounded-admission.ts", import.meta.url).pathname;
  const attempt = Bun.spawnSync([process.execPath, entry], { timeout: 30_000 });
  expect(attempt.exitCode, attempt.stderr.toString()).toBe(0);
  expect(attempt.stderr.toString()).toBe("");
}, 35_000);

test("runtime disposal failure rejects the command before broker disposal and cancels stdin", () => {
  const entry = new URL("./fixtures/command-disposal.ts", import.meta.url).pathname;
  const attempt = Bun.spawnSync([process.execPath, entry], { timeout: 5000 });
  expect(attempt.stderr.toString()).toBe("");
  expect(attempt.exitCode).toBe(0);
});
