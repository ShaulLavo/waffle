import { expect, test } from "bun:test";
import { measureSharedMemory, PROBE_CEILING_BYTES } from "../memory/reservations.js";

const GiB = 1024 ** 3;
async function measurementCase(payload: unknown, outcome: unknown): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/memory-measurement-control.ts", import.meta.url).pathname,
      JSON.stringify(payload),
      typeof outcome === "string" ? outcome : JSON.stringify(outcome),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  } finally {
    child.kill();
    await child.exited;
  }
}

test("F1 F2 bounded observation rejects once and memoizes the rejected promise", async () => {
  await measurementCase(
    {
      reachedBytes: 8 * GiB,
      chunkBytes: 8 * GiB,
      ceilingReached: false,
      growableBytes: 8 * GiB,
      counts: { "fixed-buffer": true, "shared-memory": true, "private-memory": false },
    },
    { kind: "bounded", heldBytes: 8 * GiB, chunkBytes: 8 * GiB },
  );
});

test("F5 final pre-success refusal is a memoized typed unavailable observation", async () => {
  await measurementCase(
    { reachedBytes: 0, chunkBytes: 0, ceilingReached: false },
    { kind: "unavailable" },
  );
});

test("classification at the ceiling resolves measured unbounded", async () => {
  await measurementCase(
    { reachedBytes: PROBE_CEILING_BYTES, chunkBytes: 8 * GiB, ceilingReached: true },
    "unbounded",
  );
});

const malformed = [
  null,
  {},
  { reachedBytes: -1, chunkBytes: GiB, ceilingReached: false },
  { reachedBytes: 1.5, chunkBytes: GiB, ceilingReached: false },
  { reachedBytes: 0, chunkBytes: 0, ceilingReached: true },
  { reachedBytes: 0, chunkBytes: GiB, ceilingReached: false },
  { reachedBytes: GiB, chunkBytes: 0, ceilingReached: false },
  { reachedBytes: GiB, chunkBytes: 16 * 1024 ** 2, ceilingReached: false },
  { reachedBytes: 3 * GiB, chunkBytes: 3 * GiB, ceilingReached: false },
  { reachedBytes: 3 * GiB, chunkBytes: 2 * GiB, ceilingReached: false },
  { reachedBytes: GiB, chunkBytes: GiB, ceilingReached: true },
  { reachedBytes: PROBE_CEILING_BYTES, chunkBytes: GiB, ceilingReached: false },
  { reachedBytes: PROBE_CEILING_BYTES + GiB, chunkBytes: GiB, ceilingReached: false },
  { reachedBytes: Number.MAX_SAFE_INTEGER + 1, chunkBytes: GiB, ceilingReached: false },
  { reachedBytes: GiB, chunkBytes: "1073741824", ceilingReached: false },
  { reachedBytes: GiB, chunkBytes: GiB, ceilingReached: 1 },
];
for (const [index, payload] of malformed.entries())
  test(`F5 rejects incoherent probe tuple ${index}`, async () =>
    measurementCase(payload, "invalid"));

test("real measurement is memoized, terminates the worker, and preserves desktop sizing", async () => {
  const NativeWorker = globalThis.Worker;
  let created = 0,
    terminated = 0;
  class ObservedWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      created++;
    }
    terminate() {
      terminated++;
      return super.terminate();
    }
  }
  globalThis.Worker = ObservedWorker;
  try {
    const first = measureSharedMemory({
      workerURL: new URL("../memory/probe-worker.ts", import.meta.url),
    });
    expect(measureSharedMemory()).toBe(first);
    const platform = await first;
    expect(platform.kind).toBe("unbounded");
    expect(platform.source).toBe("measured");
    expect(created).toBe(1);
    expect(terminated).toBe(1);
  } finally {
    globalThis.Worker = NativeWorker;
  }
});
