import { afterEach, expect, spyOn, test } from "bun:test";
import { SharedFilesystem, type SharedFilesystemOptions } from "../browser/shared-fs.js";
import {
  FilesystemError,
  revokeFilesystem,
  wakeTransport,
  type FilesystemConnection,
} from "../fs/protocol.js";
import {
  FILESYSTEM_REQUEST_LIMITS,
  FilesystemTransportError,
  closeRequestMemory,
} from "../fs/request-memory.js";
import { FilesystemService } from "../fs/service.js";
import { MemoryBackend } from "../fs/backend.js";
import { withVfsImplementation } from "../fs/vfs-internal.js";

const MAX_CONCURRENT = Math.max(1, Math.floor(FILESYSTEM_REQUEST_LIMITS.outstanding / 4));
const BURST_SIZE = FILESYSTEM_REQUEST_LIMITS.outstanding + 512;
const OVERFLOW_BYTES = 12 * 1024;
const previousWorker = globalThis.Worker;
const cleanups: (() => Promise<void>)[] = [];

type WorkerMessage = { connect?: FilesystemConnection; dispose?: true };
type WorkerEvent = { data?: unknown; message?: string; preventDefault(): void };

class QueuedTestWorker {
  static instances: QueuedTestWorker[] = [];
  readonly listeners = new Map<string, ((event: WorkerEvent) => void)[]>();
  readonly messages: WorkerMessage[] = [];
  terminations = 0;

  constructor() {
    QueuedTestWorker.instances.push(this);
  }
  addEventListener(type: string, listener: (event: WorkerEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).concat([listener]));
  }
  postMessage(message: WorkerMessage): void {
    this.messages.push(message);
  }
  terminate(): void {
    this.terminations++;
  }
  emit(type: string, data?: unknown): void {
    const event = { data, message: "worker crash", preventDefault() {} };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  state(status: "waiting" | "ready"): void {
    this.emit("message", { type: "filesystem-state", status });
  }
  acknowledge(): void {
    this.emit("message", { type: "filesystem-disposed" });
  }
}

class InProcessServiceWorker extends QueuedTestWorker {
  static pendingBackend: MemoryBackend | undefined;
  private readonly backend: MemoryBackend;
  service?: FilesystemService;
  constructor() {
    super();
    this.backend = InProcessServiceWorker.pendingBackend!;
  }
  override postMessage(message: WorkerMessage): void {
    super.postMessage(message);
    if (message.dispose) {
      this.acknowledge();
      return;
    }
    if (!message.connect) return;
    this.service = new FilesystemService(this.backend);
    this.service.connect(message.connect);
    this.state("ready");
  }
  override terminate(): void {
    super.terminate();
    this.service?.dispose();
  }
}

function createStandInFilesystem(options: SharedFilesystemOptions = {}) {
  globalThis.Worker = QueuedTestWorker as unknown as typeof Worker;
  const fs = new SharedFilesystem({ workerURL: "https://example.test/fs.js", ...options });
  const worker = QueuedTestWorker.instances.at(-1)!;
  cleanups.push(async () => {
    const stopping = fs.dispose();
    worker.acknowledge();
    await stopping.catch(() => {});
    for (const message of worker.messages) message.connect?.port.close();
  });
  return { fs, worker };
}

function createSeededFilesystem(seed: (backend: MemoryBackend) => void) {
  const backend = new MemoryBackend();
  seed(backend);
  InProcessServiceWorker.pendingBackend = backend;
  globalThis.Worker = InProcessServiceWorker as unknown as typeof Worker;
  const fs = new SharedFilesystem({
    mode: "memory",
    workerURL: "https://example.test/fs.js",
  });
  const worker = QueuedTestWorker.instances.at(-1)!;
  cleanups.push(async () => {
    await fs.dispose().catch(() => {});
    for (const message of worker.messages) message.connect?.port.close();
  });
  return { fs, worker };
}

function createRealWorkerFilesystem() {
  const fs = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  });
  cleanups.push(async () => {
    await fs.dispose().catch(() => {});
  });
  return fs;
}

function trackMaxInFlight(fs: SharedFilesystem) {
  let active = 0;
  let peak = 0;
  const original = fs.client.asyncCall.bind(fs.client);
  const spy = spyOn(fs.client, "asyncCall").mockImplementation(async (...args) => {
    active++;
    if (active > peak) peak = active;
    try {
      return await original(...args);
    } finally {
      active--;
    }
  });
  return {
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

async function flushToRequestQueue(fs: SharedFilesystem): Promise<void> {
  for (let tick = 0; tick < 8 && fs.client.completions.size < MAX_CONCURRENT; tick++) {
    await Promise.resolve();
  }
  expect(fs.client.completions.size).toBe(MAX_CONCURRENT);
}

function expectSettledReason(
  settled: PromiseSettledResult<unknown>,
  check: (reason: unknown) => void,
): void {
  expect(settled.status).toBe("rejected");
  if (settled.status === "rejected") check(settled.reason);
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    QueuedTestWorker.instances.length = 0;
    InProcessServiceWorker.pendingBackend = undefined;
    globalThis.Worker = previousWorker;
  }
});

test("queues >1,024 concurrent resolvePath, stat, lookup, and listFiles calls below transport quota", async () => {
  const encoder = new TextEncoder();
  const { fs } = createSeededFilesystem((backend) => {
    backend.fs.mkdirp("/repo");
    for (let index = 0; index < BURST_SIZE; index++) {
      backend.fs.writeFile(`/repo/file-${index}.ts`, encoder.encode(`file-${index}`));
    }
  });
  const tracker = trackMaxInFlight(fs);
  try {
    const resolved = await Promise.all(
      Array.from({ length: BURST_SIZE }, (_, index) => fs.resolvePath(`/repo/file-${index}.ts`)),
    );
    expect(resolved).toHaveLength(BURST_SIZE);
    for (let index = 0; index < BURST_SIZE; index++) {
      expect(resolved[index]).toEqual({ kind: "file", path: `/repo/file-${index}.ts` });
    }
    expect(tracker.peak).toBeGreaterThan(1);
    expect(tracker.peak).toBeLessThanOrEqual(Math.floor(FILESYSTEM_REQUEST_LIMITS.outstanding / 4));
    expect(tracker.active).toBe(0);
    expect(fs.client.completions.size).toBe(0);

    const [stats, lookups, listings] = await Promise.all([
      Promise.all(Array.from({ length: 600 }, (_, index) => fs.stat(`/repo/file-${index}.ts`))),
      Promise.all(Array.from({ length: 600 }, (_, index) => fs.lookup(`/repo/file-${index}.ts`))),
      Promise.all(Array.from({ length: 200 }, () => fs.listFiles("/repo"))),
    ]);
    expect(stats[0]?.kind).toBe("file");
    expect(stats[599]?.size).toBe("file-599".length);
    expect(lookups[599]?.kind).toBe("file");
    expect(listings[0]).toHaveLength(BURST_SIZE);
    expect(tracker.peak).toBeLessThanOrEqual(Math.floor(FILESYSTEM_REQUEST_LIMITS.outstanding / 4));
    expect(tracker.active).toBe(0);
  } finally {
    tracker.restore();
  }
});

test("real worker handles >1,024 concurrent resolvePath and overflowing readFile bursts cleanly", async () => {
  const fs = createRealWorkerFilesystem();
  const payload = new Uint8Array(OVERFLOW_BYTES);
  for (let index = 0; index < payload.length; index++) payload[index] = index & 0xff;
  await fs.mkdirp("/burst");
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => {
      const bytes = new Uint8Array(payload);
      bytes[0] = index;
      return fs.writeFile(`/burst/blob-${index}.bin`, bytes);
    }),
  );

  const tracker = trackMaxInFlight(fs);
  try {
    const resolved = await Promise.all(
      Array.from({ length: BURST_SIZE }, (_, index) =>
        fs.resolvePath(
          index % 2 === 0 ? `/burst/blob-${index % 8}.bin` : `/burst/missing-${index}`,
        ),
      ),
    );
    expect(resolved[0]).toEqual({ kind: "file", path: "/burst/blob-0.bin" });
    expect(resolved[1]).toBeUndefined();

    // Every readFile exceeds one transport page (4 KiB), so each active call also issues overflow `take` RPCs.
    const reads = await Promise.all(
      Array.from({ length: BURST_SIZE }, (_, index) => fs.readFile(`/burst/blob-${index % 8}.bin`)),
    );
    for (let index = 0; index < BURST_SIZE; index++) {
      const bytes = reads[index];
      expect(bytes).toBeDefined();
      expect(bytes?.length).toBe(OVERFLOW_BYTES);
      expect(bytes?.[0]).toBe(index % 8);
      expect(bytes?.[OVERFLOW_BYTES - 1]).toBe((OVERFLOW_BYTES - 1) & 0xff);
    }
    expect(tracker.peak).toBeLessThanOrEqual(Math.floor(FILESYSTEM_REQUEST_LIMITS.outstanding / 4));
    expect(tracker.active).toBe(0);
    expect(fs.client.completions.size).toBe(0);
  } finally {
    tracker.restore();
  }
});

test("non-fatal request failures release slots without stalling queued waiters", async () => {
  const fs = createRealWorkerFilesystem();
  await fs.writeFile("/existing.txt", "ok");

  const outcomes = await Promise.allSettled(
    Array.from({ length: BURST_SIZE }, (_, index) =>
      index % 4 === 0 ? fs.directoryHandle("/existing.txt") : fs.resolvePath("/existing.txt"),
    ),
  );
  for (let index = 0; index < BURST_SIZE; index++) {
    const outcome = outcomes[index]!;
    if (index % 4 === 0) {
      expectSettledReason(outcome, (reason) => {
        expect(reason).toBeInstanceOf(FilesystemError);
        expect((reason as FilesystemError).errno).toBe(54);
      });
    } else {
      expect(outcome).toEqual({
        status: "fulfilled",
        value: { kind: "file", path: "/existing.txt" },
      });
    }
  }
  expect(fs.client.completions.size).toBe(0);
});

test("waiting disposal rejects both active and queued requests promptly before worker ACK", async () => {
  const { fs, worker } = createStandInFilesystem(
    withVfsImplementation("opfs-memory", { mode: "fast" }),
  );
  worker.state("waiting");
  const pending = Array.from({ length: BURST_SIZE }, (_, index) => fs.resolvePath(`/p-${index}`));
  await flushToRequestQueue(fs);
  const disposal = fs.dispose();

  const settled = await Promise.allSettled(pending);
  expect(settled).toHaveLength(BURST_SIZE);
  for (const outcome of settled) {
    expectSettledReason(outcome, (reason) => {
      expect(reason).toBeInstanceOf(FilesystemError);
      expect((reason as FilesystemError).errno).toBe(11);
    });
  }
  worker.acknowledge();
  await disposal;
});

test("ready joined disposal rejects both active and queued requests promptly before worker ACK", async () => {
  const { fs, worker } = createStandInFilesystem();
  worker.state("ready");
  const pending = Array.from({ length: BURST_SIZE }, (_, index) => fs.resolvePath(`/r-${index}`));
  await flushToRequestQueue(fs);
  const disposal = fs.dispose();

  const settled = await Promise.allSettled(pending);
  for (const outcome of settled) {
    expectSettledReason(outcome, (reason) => {
      expect(reason).toBeInstanceOf(FilesystemError);
      expect((reason as FilesystemError).errno).toBe(11);
    });
  }
  worker.acknowledge();
  await disposal;
});

test("worker fatal failure and shared-host ownership loss reject all queued requests with the fatal error", async () => {
  const fatalFixture = createStandInFilesystem(
    withVfsImplementation("opfs-memory", { mode: "fast" }),
  );
  fatalFixture.worker.state("waiting");
  const fatalPending = Array.from({ length: BURST_SIZE }, (_, index) =>
    fatalFixture.fs.resolvePath(`/f-${index}`),
  );
  await flushToRequestQueue(fatalFixture.fs);
  fatalFixture.worker.emit("message", {
    type: "filesystem-error",
    message: "storage quota failed",
  });
  const fatalSettled = await Promise.allSettled(fatalPending);
  for (const outcome of fatalSettled) {
    expectSettledReason(outcome, (reason) => {
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).message).toContain("storage quota failed");
    });
  }

  const ownershipFixture = createStandInFilesystem({ whenBusy: "attach" });
  ownershipFixture.worker.state("ready");
  const ownershipPending = Array.from({ length: BURST_SIZE }, (_, index) =>
    ownershipFixture.fs.resolvePath(`/o-${index}`),
  );
  await flushToRequestQueue(ownershipFixture.fs);
  ownershipFixture.worker.emit("message", { type: "filesystem-ownership-lost" });
  const ownershipSettled = await Promise.allSettled(ownershipPending);
  for (const outcome of ownershipSettled) {
    expectSettledReason(outcome, (reason) => {
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).message).toContain("another tab");
    });
  }
});

test("external revocation and transport close unblock all queued requests promptly", async () => {
  const revokedFixture = createStandInFilesystem({ mode: "memory" });
  revokedFixture.worker.state("ready");
  const revokedPending = Array.from({ length: BURST_SIZE }, (_, index) =>
    revokedFixture.fs.resolvePath(`/rev-${index}`),
  );
  await flushToRequestQueue(revokedFixture.fs);
  revokeFilesystem(revokedFixture.fs.client.connection);
  const revokedSettled = await Promise.allSettled(revokedPending);
  for (const outcome of revokedSettled) {
    expectSettledReason(outcome, (reason) => {
      expect(reason).toBeInstanceOf(FilesystemError);
      expect((reason as FilesystemError).errno).toBe(11);
    });
  }

  const closedFixture = createStandInFilesystem({ mode: "memory" });
  closedFixture.worker.state("ready");
  const closedPending = Array.from({ length: BURST_SIZE }, (_, index) =>
    closedFixture.fs.resolvePath(`/closed-${index}`),
  );
  await flushToRequestQueue(closedFixture.fs);
  closeRequestMemory(closedFixture.fs.client.connection.requests, "messageerror");
  wakeTransport(closedFixture.fs.client.connection);
  const closedSettled = await Promise.allSettled(closedPending);
  for (const outcome of closedSettled) {
    expectSettledReason(outcome, (reason) => {
      expect(reason).toBeInstanceOf(FilesystemTransportError);
    });
  }
});

test("reads queued before a write finish before the write executes, and mid-burst disposal unblocks cleanly", async () => {
  const decoder = new TextDecoder();
  const fs = createRealWorkerFilesystem();
  await fs.writeFile("/order.txt", "before");

  const readsBefore = Array.from({ length: BURST_SIZE }, () => fs.readFile("/order.txt"));
  await flushToRequestQueue(fs);
  const write = fs.writeFile("/order.txt", "after");
  const readAfter = fs.readFile("/order.txt");

  const [beforeBytes, , afterBytes] = await Promise.all([
    Promise.all(readsBefore),
    write,
    readAfter,
  ]);
  for (const bytes of beforeBytes) {
    expect(decoder.decode(bytes)).toBe("before");
  }
  expect(decoder.decode(afterBytes)).toBe("after");

  // Trigger disposal mid-burst while slots are actively handing off to queued waiters.
  const midBurst = Array.from({ length: BURST_SIZE }, (_, index) =>
    fs.resolvePath(`/mid-${index}`),
  );
  await midBurst[0];
  await fs.dispose();
  const settled = await Promise.allSettled(midBurst);
  expect(settled).toHaveLength(BURST_SIZE);
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(FilesystemError);
      expect((outcome.reason as FilesystemError).errno).toBe(11);
    }
  }
});
