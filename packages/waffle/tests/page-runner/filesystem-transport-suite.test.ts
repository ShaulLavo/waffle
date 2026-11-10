import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPageSuite, type HostCase } from "waffle/testing/page-runner";
import { FakeDriver } from "./fake-driver.js";
import { bounded } from "./driver.js";
import { observeFilesystemWorkers } from "./filesystem-transport-observation.js";
import {
  filesystemTransportAdapter,
  filesystemTransportId as id,
  filesystemTransportSources,
  driveFilesystemTransport,
  checkFilesystemTransport,
} from "./filesystem-transport-suite.js";

const adapter = filesystemTransportAdapter();
const command = {
  result: {
    ok: 122,
    lost: 0,
    messageerrors: 0,
    sharedPayloads: 0,
    crossOriginIsolated: true,
    retainedBytes: 0,
    namespaceRequests: 0,
    large: { matches: true, payloads: 5, payloadBytes: 0, arenaBytes: 65536, writeMs: 1 },
  },
  observation: {
    created: 123,
    ready: 122,
    completed: 122,
    disposed: 1,
    live: 0,
    sharedBuffers: 1,
    sharedBytes: 8,
  },
};
const complete = {
  body: { status: "pass", result: command },
  teardown: { status: "pass", result: { live: 0, workerRestored: true } },
};

test("native selection is exactly one complete original command with the original clock", () => {
  expect(adapter.inventory().map((item) => item.id)).toEqual([id]);
  expect(adapter.inventory()[0]?.request("run")).toEqual({ rounds: 60 });
  expect(adapter.inventory()[0]?.drive).toBeFunction();
  expect(adapter.budgets(1)).toEqual({
    hello: 20000,
    heartbeat: 10000,
    case: 180000,
    group: 180000,
    run: 180000,
  });
  expect(adapter.policy.listIds({ ids: [id] })).toEqual([id]);
  for (const ids of [[], [id, id], ["helper"], [id, "control"]])
    expect(() => adapter.policy.listIds({ ids })).toThrow("inventory");
});

test("the HostCase invokes the original global with complete options and returns the actual value", async () => {
  const tasks: string[] = [];
  const scripts: string[] = [];
  const host: HostCase = {
    workers: async () => {
      throw new Error("Browser observation not declared");
    },
    onRequest: () => {
      throw new Error("Browser observation not declared");
    },
    async press() {
      throw new Error("Unexpected key press");
    },
    signal: new AbortController().signal,
    remainingMs: () => 180000,
    setTimeout: () => {
      throw new Error("No changed budget");
    },
    holdAsset: () => {
      throw new Error("No holds");
    },
    openPeer: async () => {
      throw new Error("No peers");
    },
    allocateDatabase: async () => {
      throw new Error("No durable storage");
    },
    sleep: async () => {
      throw new Error("No polling");
    },
    task: async (source) => {
      tasks.push(source);
    },
    script: async (source) => {
      scripts.push(source);
      return command;
    },
  };
  expect(await driveFilesystemTransport(host, 60)).toBe(command);
  expect(tasks).toEqual(["await window.__filesystemTransport.run(60);"]);
  expect(scripts).toEqual(["return window.__filesystemTransport.value;"]);
  await expect(
    driveFilesystemTransport({ ...host, signal: AbortSignal.abort("cancelled") }, 60),
  ).rejects.toBe("cancelled");
  expect(tasks).toHaveLength(1);
});

test("complete results require all branches, genuine shared observations and cleanup", () => {
  expect(() => checkFilesystemTransport(60, complete)).not.toThrow();
  for (const patch of [
    { ok: 120 },
    { lost: 1 },
    { messageerrors: 1 },
    { sharedPayloads: 1 },
    { crossOriginIsolated: false },
    { retainedBytes: -1 },
    { namespaceRequests: 1 },
    { large: undefined },
  ])
    expect(() =>
      checkFilesystemTransport(60, {
        ...complete,
        body: { status: "pass", result: { ...command, result: { ...command.result, ...patch } } },
      }),
    ).toThrow();
  for (const patch of [
    { created: 1 },
    { ready: 0 },
    { completed: 120 },
    { disposed: 0 },
    { live: 1 },
    { sharedBuffers: 0 },
    { sharedBytes: 0 },
  ])
    expect(() =>
      checkFilesystemTransport(60, {
        ...complete,
        body: {
          status: "pass",
          result: { ...command, observation: { ...command.observation, ...patch } },
        },
      }),
    ).toThrow("observations");
  for (const value of [
    undefined,
    {},
    { ...complete, body: { status: "fail", error: "REAL_ASSERTION" } },
    { ...complete, teardown: { status: "fail", error: "REAL_CLEANUP" } },
    { ...complete, teardown: { status: "pass", result: { live: 1, workerRestored: false } } },
  ])
    expect(() => checkFilesystemTransport(60, value)).toThrow();
});

test("observations require a real Worker mutating the actual shared buffer", async () => {
  const NativeWorker = globalThis.Worker;
  const owner = observeFilesystemWorkers();
  try {
    const worker = new Worker(
      new URL("../fixtures/filesystem-transport-observation-worker.ts", import.meta.url),
    );
    const ready = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    worker.addEventListener("message", ({ data }) =>
      data.type === "ready" ? ready.resolve() : done.resolve(),
    );
    const shared = new SharedArrayBuffer(4);
    await bounded(ready.promise, 1000, "actual Worker ready");
    worker.postMessage(shared);
    await bounded(done.promise, 1000, "actual Worker mutation");
    expect(Atomics.load(new Int32Array(shared), 0)).toBe(1);
    expect(owner.snapshot()).toEqual({
      created: 1,
      ready: 1,
      completed: 1,
      disposed: 0,
      live: 1,
      sharedBuffers: 1,
      sharedBytes: 4,
    });
    expect(owner.restored()).toBe(false);
  } finally {
    owner.close();
    owner.close();
  }
  expect(owner.snapshot().live).toBe(0);
  expect(globalThis.Worker).toBe(NativeWorker);
  expect(owner.restored()).toBe(true);
});

for (const mode of [
  "pass",
  "assertion",
  "finish-error",
  "close",
  "driver-lost",
  "cleanup-fails",
] as const) {
  test(`host result and cleanup propagate ${mode} without native resources`, async () => {
    const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wft-unit-"));
    const driver = new FakeDriver(mode, {
      list: { ids: [id] },
      result: complete,
    });
    try {
      // FakeDriver checks result/OS propagation only, never original-body acceptance.
      const fake = {
        ...adapter,
        inventory: () => adapter.inventory().map(({ drive: _drive, ...item }) => item),
      };
      const path = join(root, "result.json");
      const result = await runPageSuite(fake, () => driver, {
        resultPath: path,
        scratchRoot: root,
        port: "ephemeral",
        assets: {},
      });
      expect(await Bun.file(path).json()).toEqual(result);
      expect(result.selected).toEqual([id]);
      expect(result.omitted).toEqual([]);
      expect(result.exit === 0).toBe(mode === "pass");
      expect(driver.stopCalls).toBeGreaterThan(0);
      if (mode === "pass") expect(result.results[id]).toEqual(complete);
      if (mode !== "cleanup-fails") expect(result.cleanup.scratch.status).toBe("confirmed");
    } finally {
      await driver.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("native CLI branches before desktop resources and preserves precondition and write exits", async () => {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wft-cli-"));
  async function invoke(args: string[]) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../filesystem-transport-browser-runner.ts"),
        "ios-safari",
      ].concat(args),
      {
        env: {
          ...process.env,
          IOS_UDID: "",
          FS_TRANSPORT_SCRATCH_ROOT: root,
          STORAGE_TEST_FILTER: "must-not-filter",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      return await child.exited;
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }
  try {
    const path = join(root, "result.json");
    expect(await invoke(["--result", path])).toBe(3);
    expect(await Bun.file(path).json()).toEqual({
      suite: "filesystem-transport",
      exit: 3,
      precondition: "Darwin and exact IOS_UDID required; no native resources allocated",
    });
    expect(await invoke(["--result", join(path, "cannot-write.json")])).toBe(2);
    expect(await invoke(["--old-source", "historical", "--result", path])).toBe(3);
    expect(await readdir(root)).toEqual(["result.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary desktop command and all original browser producers remain byte-identical", async () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const source = await Bun.file(
    resolve(import.meta.dir, "../filesystem-transport-browser-runner.ts"),
  ).text();
  const oldPrelude = source.slice(source.indexOf("const startedAt"), source.indexOf("const args"));
  expect(sha(source.replace(oldPrelude, ""))).toBe(
    "5581502ec10f04dd240a9d9fd2f071d41d98fb1787852c8ffbe411ec6c0e6573",
  );
  expect(
    sha(await Bun.file(resolve(import.meta.dir, "../filesystem-transport-browser.ts")).text()),
  ).toBe("d44ab07b48bfa1283aaa1a42ad0408dae5126beafb33ab426492990e0a0655db");
  expect(
    sha(
      await Bun.file(resolve(import.meta.dir, "../filesystem-transport-browser-driver.ts")).text(),
    ),
  ).toBe("a3060737f0f26310d3dddd7f534056a09917ac8d899d454dfd39aea0c1fd641d");
  const assets = await adapter.assets({ scratch: tmpdir(), signal: new AbortController().signal });
  for (const [route, source] of Object.entries(filesystemTransportSources)) {
    const original = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "..", source)],
      target: "browser",
      format: "esm",
      define: { LEGACY_SOURCE: "false" },
    });
    expect(original.success).toBe(true);
    const actual = assets[route];
    if (!actual || typeof actual === "string") throw new Error("Missing original producer");
    expect(await actual.text()).toBe(await original.outputs[0]!.text());
  }
});
