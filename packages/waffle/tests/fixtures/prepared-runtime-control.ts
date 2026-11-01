import assert from "node:assert/strict";
const mode = process.argv[2]!;
if (mode !== "default")
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    get() {
      throw new Error("prepared override read navigator");
    },
  });
const nativeWorker = Worker;
const nativeShared = SharedArrayBuffer;
let workers = 0;
let backing = 0;
const owned: Worker[] = [];
globalThis.SharedArrayBuffer = new Proxy(nativeShared, {
  construct(target, args) {
    backing++;
    return Reflect.construct(target, args);
  },
});
globalThis.Worker = new Proxy(nativeWorker, {
  construct(target, args) {
    workers++;
    const worker = Reflect.construct(target, args);
    owned.push(worker);
    return worker;
  },
});
const api: typeof import("../../index.js") = await import("waffle");
assert(import.meta.resolve("waffle").includes("/dist/"), "must exercise the prepared package root");
const { testSharedMemory } = await import("./shared-memory-platform.js");
const options = {
  filesystem: {
    mode: "memory" as const,
    workerURL: new URL("browser/fs-worker.js", import.meta.resolve("waffle")),
  },
};
assert.throws(() => api.createRuntime({ ...options, sharedMemory: testSharedMemory }), TypeError);
const issued = api.declareSharedMemoryPlatform(
  mode === "bounded"
    ? {
        kind: "bounded",
        budgetBytes: api.bytes(3 * 1024 ** 3),
        counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
      }
    : { kind: "unbounded" },
);
assert.throws(() => api.createRuntime({ ...options, sharedMemory: { ...issued } }), TypeError);
assert.throws(
  () =>
    api.createRuntime({ ...options, sharedMemory: { kind: "unbounded", source: "application" } }),
  TypeError,
);
assert.deepEqual([workers, backing], [0, 0]);
const runtime = api.createRuntime({
  ...options,
  ...(mode === "default" ? {} : { sharedMemory: issued }),
});
try {
  await runtime.filesystem.writeFile("/prepared-control", "ok");
  assert.equal(
    new TextDecoder().decode(await runtime.filesystem.readFile("/prepared-control")),
    "ok",
  );
  assert.equal(
    runtime.sharedMemory.snapshot().platform.source,
    mode === "default" ? "profile" : "application",
  );
  assert.equal(
    runtime.sharedMemory.snapshot().platform.kind,
    mode === "bounded" ? "bounded" : "unbounded",
  );
  assert.equal(workers, 1);
} finally {
  await runtime.dispose();
  await Promise.all(owned.map((worker) => worker.terminate()));
}
