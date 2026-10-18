import { afterEach, expect, test } from "bun:test";
import { SharedFilesystem, type SharedFilesystemOptions } from "../browser/shared-fs.js";
import { createRuntime } from "../runtime.js";
import { FilesystemSection, FilesystemError } from "../fs/protocol.js";

const originalWorker = globalThis.Worker;
const workers: TestWorker[] = [];
const filesystems: SharedFilesystem[] = [];
class TestWorker {
  listeners = new Map<string, ((event: any) => void)[]>();
  messages: any[] = [];
  terminations = 0;
  private requested!: () => void;
  readonly disposalRequested = new Promise<void>((resolve) => {
    this.requested = resolve;
  });
  constructor() {
    workers.push(this);
  }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).concat([listener]));
  }
  postMessage(message: any) {
    this.messages.push(message);
    if (message.dispose) this.requested();
  }
  terminate() {
    this.terminations++;
  }
  emit(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  state(status: string) {
    this.emit("message", { data: { type: "filesystem-state", status } });
  }
  acknowledge() {
    this.emit("message", { data: { type: "filesystem-disposed" } });
  }
}
function setup(): SharedFilesystem {
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  const filesystem = new SharedFilesystem({
    vfs: "opfs-memory",
    workerURL: "https://example.test/fs.js",
  });
  filesystems.push(filesystem);
  return filesystem;
}
afterEach(async () => {
  for (const worker of workers) worker.acknowledge();
  for (const filesystem of filesystems.splice(0)) await filesystem.dispose().catch(() => {});
  for (const worker of workers.splice(0))
    for (const message of worker.messages) message.connect?.port.close();
  globalThis.Worker = originalWorker;
});

test("waiting disposal revokes operations immediately and awaits one abort acknowledgement", async () => {
  const filesystem = setup(),
    worker = workers[0]!;
  worker.state("waiting");
  const operation = filesystem.writeFile("/pending", "never served").catch((error) => error);
  const disposal = filesystem.dispose();
  expect(filesystem.dispose()).toBe(disposal);
  expect(filesystem.state.status).toBe("disposed");
  expect(worker.messages.filter((message) => message.dispose)).toHaveLength(1);
  expect(worker.terminations).toBe(0);
  expect(await operation).toMatchObject({ errno: 11 });
  worker.acknowledge();
  await disposal;
  worker.acknowledge();
  worker.state("ready");
  expect(worker.terminations).toBe(1);
  expect(filesystem.state.status).toBe("disposed");
});

test("a malformed worker response rejects pending disposal and terminates once", async () => {
  const filesystem = setup(),
    worker = workers[0]!;
  const disposal = filesystem.dispose();
  const failure = disposal.catch((error) => error);
  worker.emit("messageerror", {});
  expect((await failure).message).toContain("could not be decoded");
  worker.acknowledge();
  expect(worker.terminations).toBe(1);
});

test("fatal startup is not revived by a late ready message", async () => {
  const filesystem = setup(),
    worker = workers[0]!;
  worker.emit("message", { data: { type: "filesystem-error", message: "storage is broken" } });
  worker.state("ready");
  expect(filesystem.state.status).toBe("failed");
  expect(filesystem.state.error?.message).toContain("storage is broken");
  expect(worker.terminations).toBe(1);
});

for (const status of ["waiting", "ready", "failed", "disposed"] as const) {
  test(`a ${status} observer can dispose without abandoning worker acknowledgement`, async () => {
    const filesystem = setup(),
      worker = workers[0]!;
    let disposal: Promise<void> | undefined;
    let observedError: Error | undefined;
    filesystem.onStateChange = (state) => {
      if (state.status === status) {
        observedError = state.error;
        disposal = filesystem.dispose();
      }
    };
    if (status === "failed")
      worker.emit("message", { data: { type: "filesystem-error", message: "storage is broken" } });
    else if (status === "disposed") filesystem.dispose();
    else worker.state(status);
    expect(disposal).toBeDefined();
    const aborts = worker.messages.filter((message) => message.dispose);
    // A terminal/ready worker must never be killed with an unacknowledged abort handshake.
    expect(aborts).toHaveLength(status === "waiting" || status === "disposed" ? 1 : 0);
    if (aborts.length) worker.acknowledge();
    await disposal;
    expect(filesystem.dispose()).toBe(disposal!);
    expect(worker.terminations).toBe(1);
    if (status === "failed") {
      expect(observedError?.message).toContain("storage is broken");
      const failure = await filesystem.listFiles().catch((error) => error);
      expect(failure.message).toContain("storage is broken");
    }
  });
}

for (const filesystemOptions of [
  { vfs: "opfs-memory" },
  { vfs: "indexeddb" },
  { vfs: "indexeddb", whenBusy: "takeover" },
  { vfs: "indexeddb", whenBusy: "wait" },
] as const) {
  test(`runtime cancels pending ${filesystemOptions.vfs} ${"whenBusy" in filesystemOptions ? filesystemOptions.whenBusy : "default"} startup before draining queued mutations`, async () => {
    globalThis.Worker = TestWorker as unknown as typeof Worker;
    const runtime = createRuntime({
      filesystem: { ...filesystemOptions, workerURL: "https://example.test/fs.js" },
    });
    const worker = workers[0]!;
    const operation = runtime.filesystem.mkdirp("/pending").catch((error) => error);
    const disposal = runtime.dispose();
    try {
      const failure = await operation;
      expect(failure).toBeInstanceOf(FilesystemError);
      expect(failure.errno).toBe(11);
      await worker.disposalRequested;
      expect(worker.messages.filter((message) => message.dispose)).toHaveLength(1);
      worker.acknowledge();
      await disposal;
      expect(worker.terminations).toBe(1);
    } finally {
      // A pre-fix runtime is stuck in drain; revoke it so the negative control cleans up.
      worker.emit("message", { data: { type: "filesystem-error", message: "test cleanup" } });
      worker.acknowledge();
      await disposal.catch(() => {});
    }
  });
}

test("a disposed state observer reenters the same runtime disposal", async () => {
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  let reentered: Promise<void> | undefined;
  const runtime = createRuntime({
    filesystem: {
      vfs: "opfs-memory",
      workerURL: "https://example.test/fs.js",
      onStateChange(state) {
        if (state.status === "disposed") reentered = runtime.dispose();
      },
    },
  });
  const worker = workers[0]!;
  worker.state("waiting");
  const disposal = runtime.dispose();
  await worker.disposalRequested;
  worker.acknowledge();
  await Promise.all([disposal, reentered]);
  expect(reentered).toBe(disposal);
  expect(worker.terminations).toBe(1);
});

test("OPFS takeover is excluded by type and rejected before creating a worker", () => {
  // @ts-expect-error OPFS exclusive sync-access handles cannot be taken over safely.
  const options: SharedFilesystemOptions = { vfs: "opfs-memory", whenBusy: "takeover" };
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  expect(() => new SharedFilesystem(options)).toThrow(
    "opfs-memory does not support whenBusy: takeover",
  );
  expect(workers).toHaveLength(0);
});

for (const whenBusy of ["takeover", "wait"] as const) {
  test(`pending IndexedDB ${whenBusy} disposal fences admitted consumers before aborting storage`, async () => {
    globalThis.Worker = TestWorker as unknown as typeof Worker;
    const runtime = createRuntime({
      filesystem: { whenBusy, workerURL: "https://example.test/fs.js" },
    });
    const worker = workers[0]!;
    const identity = runtime.filesystem.fork();
    const section = new FilesystemSection(identity);
    let stopped = false;
    runtime.retainConsumer({
      filesystem: identity,
      revoke() {},
      stop() {
        stopped = true;
      },
    });
    section.enter();
    const operation = runtime.filesystem.mkdirp("/pending").catch((error) => error);
    const disposal = runtime.dispose();
    try {
      expect(await operation).toBeInstanceOf(FilesystemError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(worker.messages.filter((message) => message.dispose)).toHaveLength(0);
      expect(worker.terminations).toBe(0);
      expect(stopped).toBe(false);
      expect(() => new FilesystemSection(identity).enter()).toThrow(FilesystemError);
    } finally {
      section.exit();
      await worker.disposalRequested;
      expect(stopped).toBe(true);
      worker.acknowledge();
      await disposal;
      identity.port.close();
    }
    expect(worker.terminations).toBe(1);
  });
}

test("runtime disposal preserves a fatal IndexedDB startup error", async () => {
  globalThis.Worker = TestWorker as unknown as typeof Worker;
  const runtime = createRuntime({ filesystem: { workerURL: "https://example.test/fs.js" } });
  const worker = workers[0]!;
  worker.emit("message", { data: { type: "filesystem-error", message: "IndexedDB open failed" } });
  await expect(runtime.dispose()).rejects.toThrow("IndexedDB open failed");
  expect(worker.messages.filter((message) => message.dispose)).toHaveLength(0);
  expect(worker.terminations).toBe(1);
});
