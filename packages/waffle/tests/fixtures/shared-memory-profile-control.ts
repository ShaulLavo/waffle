import type { SharedMemorySnapshot } from "../../memory/reservations.js";
import assert from "node:assert/strict";
const mode = process.argv[2]!;
const entry = process.argv[3]!;
const NativeWorker = globalThis.Worker;
const NativeShared = globalThis.SharedArrayBuffer;
const NativeMemory = WebAssembly.Memory;
let reads = 0;
let backing = 0;
let workers = 0;
let fail = mode === "failed";
const urls: string[] = [];
const ios = {
  userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148",
  maxTouchPoints: 5,
};
const desktop = {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605",
  maxTouchPoints: 0,
};
if (mode === "absent") Reflect.deleteProperty(globalThis, "navigator");
else
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    get() {
      reads++;
      if (mode.startsWith("override") || mode === "import")
        throw new Error("environment read forbidden");
      return mode === "mobile" ? ios : desktop;
    },
  });
globalThis.SharedArrayBuffer = new Proxy(NativeShared, {
  construct(target, args) {
    backing++;
    return Reflect.construct(target, args);
  },
});
WebAssembly.Memory = new Proxy(NativeMemory, {
  construct(target, args) {
    backing++;
    return Reflect.construct(target, args);
  },
});
globalThis.Worker = new Proxy(NativeWorker, {
  construct(target, args) {
    workers++;
    urls.push(String(args[0]));
    if (fail) throw new Error("injected filesystem construction failure");
    return Reflect.construct(target, args);
  },
});
const api = await import(entry);
assert.deepEqual([reads, backing, workers], [0, 0, 0]);
if (mode === "import") process.exit(0);
if (mode === "select") {
  assert.equal(api.sharedMemoryProfile(ios).profile, "apple-mobile-webkit");
  assert.deepEqual([reads, backing, workers], [0, 0, 0]);
  process.exit(0);
}
let processStarts = 0;
let sentinelCalls = 0;
const allocator = await import(
  new URL(entry.endsWith(".ts") ? "./memory/allocator.ts" : "./memory/allocator.js", entry).href
);
const restoreAllocator = allocator.installSharedControlAllocator((length: number) => {
  sentinelCalls++;
  return new NativeShared(length);
});
const options = {
  processHost() {
    processStarts++;
    throw new Error("unexpected process activation");
  },
  filesystem: { mode: "memory", workerURL: new URL("../../browser/fs-worker.ts", import.meta.url) },
};
if (mode === "forged") {
  const platform = api.declareSharedMemoryPlatform({ kind: "unbounded" });
  let accidental: { dispose(): Promise<void> } | undefined;
  try {
    for (const forged of [
      { ...platform },
      JSON.parse(JSON.stringify(platform)),
      { kind: "bounded", source: "profile", profile: "apple-mobile-webkit" },
    ])
      assert.throws(() => {
        accidental = api.createRuntime({ ...options, sharedMemory: forged });
      }, TypeError);
    assert.deepEqual([backing, workers], [0, 0]);
  } finally {
    await accidental?.dispose();
  }
}
if (mode === "override")
  Object.assign(options, { sharedMemory: api.declareSharedMemoryPlatform({ kind: "unbounded" }) });
if (mode === "override-bounded")
  Object.assign(options, {
    sharedMemory: api.declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: api.bytes(4 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
    }),
  });
if (mode === "failed") {
  assert.throws(() => api.createRuntime(options), /injected filesystem/);
  fail = false;
  allocator.allocateSharedControl(4);
  assert.equal(sentinelCalls, 1);
}
const runtime = api.createRuntime(options);
try {
  await runtime.filesystem.writeFile("/profile-control", "ok");
  assert.equal(
    new TextDecoder().decode(await runtime.filesystem.readFile("/profile-control")),
    "ok",
  );
  const snapshot: SharedMemorySnapshot = runtime.sharedMemory.snapshot();
  assert.equal(snapshot.platform.source, mode.startsWith("override") ? "application" : "profile");
  if (!mode.startsWith("override")) {
    assert(snapshot.platform.source === "profile");
    assert.equal(snapshot.platform.profile, mode === "mobile" ? "apple-mobile-webkit" : "desktop");
  }
  assert.equal(urls.filter((url) => url.includes("probe")).length, 0);
  assert.equal(workers, mode === "failed" ? 2 : 1);
  assert.equal(
    snapshot.holders.filter((h) => h.label === "filesystem-segment" && h.state === "live").length,
    95,
  );
  assert.equal(
    snapshot.holders.find((h) => h.label === "request-arena" && h.state === "live")?.declaredBytes,
    mode === "mobile" || mode === "override-bounded" ? 67108864 : 2147479552,
  );
  assert.equal(processStarts, 0);
  if (mode === "ownership") {
    assert.throws(
      () =>
        api.createRuntime({
          ...options,
          sharedMemory: { kind: "unbounded", source: "application" },
        }),
      /live page runtime/,
    );
    assert.equal(runtime.sharedMemory.snapshot().platform, snapshot.platform);
    const before = runtime.sharedMemory.snapshot().reservedBytes;
    allocator.allocateSharedControl(4);
    assert.equal(runtime.sharedMemory.snapshot().reservedBytes, before + 4);
    assert.equal(sentinelCalls, 0);
  }
} finally {
  await runtime.dispose();
}
if (mode === "failed" || mode === "ownership") {
  const next = api.createRuntime(options);
  await next.dispose();
}
if (mode.startsWith("override")) assert.equal(reads, 0);

allocator.allocateSharedControl(4);
assert.equal(sentinelCalls, mode === "failed" ? 2 : 1);
restoreAllocator();
