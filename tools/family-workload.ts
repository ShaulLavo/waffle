import { coreutils } from "@waffle-os/coreutils";
import {
  createRuntime,
  type ProcessService,
  type ProcessStartState,
  type Runtime,
} from "@waffle-os/runtime";
import type { ProcessExit } from "@waffle-os/runtime/proc/types";
import { withProgramAcceptance, type FamilyAcceptanceSession } from "./family-acceptance.ts";
import assert, { ok } from "./test-assert.ts";

const workerUrl = new URL("/preview1-worker.js", location.href);
const filesystem = {
  mode: "fast",
  name: "binary-workload",
  workerURL: new URL("/fs-worker.js", location.href),
} as const;
const programs = ["/usr/bin/cat", "/usr/bin/sha256sum"];
const inputPath = "/input";
const digestPath = "/digest";
const partialPath = "/partial";
const readRights = (1n << 1n) | (1n << 21n) | (1n << 27n);
const writeRights = (1n << 6n) | (1n << 21n) | (1n << 27n);
const payload = Uint8Array.from(
  { length: 2 * 1024 * 1024 },
  (_, index) => (index * 31) ^ (index >>> 8),
);
const chunkBytes = 256 * 1024;
const prefix = payload.slice(0, 4096);
const visibility: { state: DocumentVisibilityState; at: number }[] = [];
document.addEventListener("visibilitychange", () => {
  visibility.push({ state: document.visibilityState, at: performance.now() });
});

const packageUnderTest = {
  ...coreutils,
  programs: coreutils.programs.filter((program) => programs.includes(program.path)),
};
assert.equal(packageUnderTest.programs.length, 2);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function until<T>(probe: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const limit = performance.now() + 30_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    ok(performance.now() < limit, "Timed out waiting for " + label);
    await sleep(2);
  }
}

function request(argv: string[], stdin = 0, stdout = 1) {
  return {
    executable: "/usr/bin/" + argv[0],
    argv,
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", PWD: "/", LC_ALL: "C" },
    fds: [
      { child: 0, parent: stdin },
      { child: 1, parent: stdout },
      { child: 2, parent: 2 },
    ],
  };
}

function expectExit(exit: ProcessExit, code = 0) {
  assert.equal(exit.kind, "exited", JSON.stringify(exit));
  assert.equal(exit.code, code, JSON.stringify(exit));
}

async function time<T>(operation: () => Promise<T>) {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
}

function memory(runtime: Runtime, service: ProcessService) {
  const { holders, reservedBytes, awaitingReleaseBytes, debtBytes } =
    runtime.sharedMemory.snapshot();
  return {
    chargedReservationBytes: reservedBytes,
    awaitingReleaseBytes,
    debtBytes,
    holders,
    linearMemory: service.workerMemory().map(({ pid, bytes }) => ({ pid, bytes })),
  };
}

function pipeStorage({
  buffer,
  registry,
  capacity,
  maxReaders,
  maxWriters,
}: ReturnType<ReturnType<FamilyAcceptanceSession["pipe"]>[0]["handle"]>) {
  return {
    capacityPerLane: capacity,
    maxReaders,
    maxWriters,
    fixedBufferBytes: buffer.byteLength,
    registryBytes: registry?.buffer.byteLength,
    registryMaxBytes: registry?.buffer.maxByteLength,
  };
}

async function prepareInput(fs: Runtime["filesystem"]) {
  const small = await time(async () => {
    for (let index = 0; index < 16; index++) {
      const path = "/small-" + index;
      await fs.writeFile(path, prefix.subarray(0, 128));
      assert.equal((await fs.lookup(path))?.kind, "file");
      assert.equal((await fs.readFile(path))?.byteLength, 128);
      ok(await fs.remove(path));
    }
  });
  const append = await time(async () => {
    await fs.writeFile(inputPath, new Uint8Array());
    for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) {
      await fs.writeFile(inputPath, payload.subarray(offset, offset + chunkBytes), true);
    }
  });
  const reread = await time(() => fs.readFile(inputPath));
  ok(reread.value);
  ok(reread.value.every((byte, index) => byte === payload[index]));
  assert.equal(reread.value.byteLength, payload.byteLength);
  // Overwriting the seeded file uses one request with the same total byte count.
  const overwrite = await time(() => fs.writeFile(inputPath, payload));
  return {
    smallMs: small.ms,
    appendMs: append.ms,
    sequentialReadMs: reread.ms,
    overwriteMs: overwrite.ms,
  };
}

function programStages() {
  const loads = performance.getEntriesByType("measure");
  return loads
    .filter(
      (entry): entry is PerformanceMeasure =>
        "detail" in entry && entry.name.startsWith("waffle:program:"),
    )
    .map(({ name, startTime, duration, detail }) => ({
      stage: name.slice("waffle:program:".length),
      startTime,
      duration,
      detail,
    }));
}

function observeWorkers(
  service: ProcessService,
  starts: Map<number, ProcessStartState>,
  linearBytes: Map<number, number>,
) {
  for (const worker of service.startStates()) starts.set(worker.pid, worker);
  for (const { pid, bytes } of service.workerMemory()) {
    if (bytes !== null) linearBytes.set(pid, Math.max(linearBytes.get(pid) ?? 0, bytes));
  }
}

async function runPipeline(
  session: FamilyAcceptanceSession,
  service: ProcessService,
  digest: Uint8Array,
) {
  const { filesystem: fs, descriptors, runtime } = session;
  performance.clearMeasures();
  performance.clearResourceTimings();
  session.resetOutput();
  await fs.writeFile(digestPath, new Uint8Array());
  const output = await session.outputFile(digestPath);
  const [reader, writer] = session.pipe();
  const pipe = pipeStorage(reader.handle());
  const input = descriptors.open(reader, readRights, 0n);
  const outputPipe = descriptors.open(writer, writeRights, 0n);
  const start = performance.now();
  try {
    // Keep the read end open and delay consumer launch until the producer fills its lane.
    const cat = await time(() => session.spawn(request(["cat", inputPath], 0, outputPipe)));
    descriptors.close(outputPipe);
    ok(payload.byteLength > pipe.capacityPerLane);
    const queued = await until(() => {
      const bytes = reader.readiness().nbytes ?? 0;
      return bytes === pipe.capacityPerLane ? bytes : undefined;
    }, "cat's full pipe lane");
    const beforeConsumerMs = performance.now() - start;
    const blocked = memory(runtime, service);
    const starts = new Map<number, ProcessStartState>();
    const observedLinearBytes = new Map<number, number>();
    const sample = () => observeWorkers(service, starts, observedLinearBytes);
    sample();
    const sha = await time(() => session.spawn(request(["sha256sum", "-"], input, output)));
    const running = memory(runtime, service);
    descriptors.close(input);
    descriptors.close(output);
    const first = await time(() =>
      until(async () => {
        sample();
        const bytes = await fs.readFile(digestPath);
        return bytes?.length ? bytes : undefined;
      }, "file-directed digest"),
    );
    const firstFileOutputMs = performance.now() - start;
    const exits = await Promise.all([cat.value.exit, sha.value.exit]);
    for (const exit of exits) expectExit(exit);
    const exitMs = performance.now() - start;
    const drained = await fs.readFile(digestPath);
    assert.deepEqual(Array.from(drained ?? []), Array.from(digest), "digest bytes");
    ok(
      first.value.every((byte, index) => byte === digest[index]),
      "first file output prefix",
    );
    assert.deepEqual(session.outputBytes(), { stdout: 0, stderr: 0 }, "output used a terminal");
    await until(() => service.workerMemory().length === 0, "pipeline worker retirement");
    const assets = performance
      .getEntriesByType("resource")
      .filter(
        (entry): entry is PerformanceResourceTiming =>
          "transferSize" in entry && entry.name.endsWith(".wasm"),
      )
      .map(({ name, duration, transferSize, decodedBodySize }) => ({
        path: new URL(name).pathname,
        duration,
        transferSize,
        decodedBodySize,
      }));
    return {
      catStartMs: cat.ms,
      shaStartMs: sha.ms,
      beforeConsumerMs,
      firstFileOutputMs,
      exitMs,
      pipe,
      backpressureQueuedBytes: queued,
      assets,
      load: programStages(),
      starts: Array.from(starts.values()),
      observedLinearBytes: Array.from(observedLinearBytes, ([pid, bytes]) => ({ pid, bytes })),
      blocked,
      running,
      retired: memory(runtime, service),
    };
  } finally {
    descriptors.close(outputPipe);
    descriptors.close(input);
    descriptors.close(output);
  }
}

async function cancelPartial(
  session: FamilyAcceptanceSession,
  service: ProcessService,
  cycle: string,
) {
  const { descriptors, filesystem: fs, runtime } = session;
  await fs.writeFile(partialPath, new Uint8Array());
  const output = await session.outputFile(partialPath);
  const [reader, writer] = session.pipe();
  const input = descriptors.open(reader, readRights, 0n);
  try {
    assert.equal(writer.tryWrite([prefix]), prefix.length);
    const cat = await session.spawn(request(["cat"], input, output));
    descriptors.close(input);
    descriptors.close(output);
    const partial = await until(async () => {
      const bytes = await fs.readFile(partialPath);
      return bytes?.length === prefix.length ? bytes : undefined;
    }, "cat's partial file output");
    ok(partial.every((byte, index) => byte === prefix[index]));
    const before = memory(runtime, service);
    if (cycle === "fresh") {
      document.body.dataset.blocked = "true";
      await until(() => document.body.dataset.resumed === "true", "foreground control");
    }
    const cancelled = await time(async () => {
      await cat.interrupt();
      const exit = await cat.exit;
      assert.equal(exit.code, 130);
      ok(exit.kind === "exited" || exit.kind === "signaled");
      await until(() => service.workerMemory().length === 0, "cancelled worker retirement");
      return exit;
    });
    const final = await fs.readFile(partialPath);
    ok(final);
    assert.equal(final.length, prefix.length);
    ok(final.every((byte, index) => byte === prefix[index]));
    assert.deepEqual(session.outputBytes(), { stdout: 0, stderr: 0 });
    return { exit: cancelled.value, ms: cancelled.ms, partialBytes: final.length, before };
  } finally {
    descriptors.close(input);
    descriptors.close(output);
    writer.close();
  }
}

async function round(digest: Uint8Array, reopened: boolean) {
  const startup: { stage: string; at: number }[] = [];
  const runtime = createRuntime({
    filesystem,
    onStartupStage: (stage, timestamp) => {
      startup.push({ stage, at: timestamp - performance.timeOrigin });
    },
  });
  try {
    const before = await time(() => runtime.filesystem.lookup("/"));
    assert.equal(before.value?.kind, "dir");
    if (reopened) {
      const durable = await runtime.filesystem.readFile(digestPath);
      assert.deepEqual(Array.from(durable ?? []), Array.from(digest), "digest after reopen");
    }
    const io = await prepareInput(runtime.filesystem);
    return await withProgramAcceptance(
      { runtime, workerUrl, packages: [packageUnderTest], redirectFiles: true },
      async (session) => {
        const service = await runtime.processes();
        const idle = memory(runtime, service);
        const spareBefore = service.workerMemory().length;
        assert.equal(spareBefore, 0);
        const first = await runPipeline(session, service, digest);
        const cancel = await cancelPartial(session, service, reopened ? "reopened" : "fresh");
        const missing = await session.exec(request(["cat", "/missing"]));
        expectExit(missing.exit, 1);
        assert.equal(missing.stdout.length, 0);
        const warm = await runPipeline(session, service, digest);
        assert.equal(warm.assets.length, 0, "warm execution fetched guest assets");
        assert.equal(warm.load.length, 0, "warm execution reentered the loader");
        const flush = await time(() => runtime.filesystem.flush());
        return {
          startup,
          readyMs: before.ms,
          io,
          idle,
          spareBefore,
          first,
          cancel,
          warm,
          flushMs: flush.ms,
        };
      },
    );
  } finally {
    await runtime.dispose();
    assert.equal(runtime.disposed, true);
  }
}

async function run() {
  ok(crossOriginIsolated, "Browser must enable COOP and COEP");
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  const hex = Array.from(sha, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const digest = new TextEncoder().encode(hex + "  -\n");
  const fresh = await round(digest, false);
  assert.equal(fresh.first.assets.length, 2, "fresh execution fetched both guests");
  const reopened = await round(digest, true);
  assert.equal(reopened.first.assets.length, 2, "reopened runtime fetched both guests");
  return {
    name: "packed-coreutils-cat-sha256sum",
    inputBytes: payload.byteLength,
    inputSha256: hex,
    filesystem: filesystem.mode,
    isolated: crossOriginIsolated,
    userAgent: navigator.userAgent,
    visibility,
    fresh,
    reopened,
  };
}

try {
  const result = await run();
  document.body.textContent = JSON.stringify({ ok: true, result });
  document.body.dataset.disposed = "true";
} catch (error) {
  document.body.textContent = JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
  });
} finally {
  document.body.dataset.done = "true";
}
