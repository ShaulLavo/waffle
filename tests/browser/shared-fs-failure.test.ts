import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, type FilesystemConnection } from "@bun-wasm/runtime/fs";
import { SharedFilesystem } from "../src/shared-fs";

// The real page controller and SAB clients run unchanged; only the Worker event source
// is replaced so load failure and death during an operation have deterministic ordering.
class FailingWorker extends EventTarget {
  static current: FailingWorker;
  static service: FilesystemService | undefined;
  ports: MessagePort[] = [];
  terminated = false;
  constructor(..._args: unknown[]) { super(); FailingWorker.current = this; }
  postMessage(message: { connect: FilesystemConnection }) {
    this.ports.push(message.connect.port);
    FailingWorker.service?.connect(message.connect);
  }
  terminate() { this.terminated = true; for (const port of this.ports) port.close(); }
  crash(message: string) {
    const event = new Event("error", { cancelable: true });
    Object.defineProperty(event, "message", { value: message });
    this.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
}

async function fixture(body: () => Promise<void>) {
  const worker = globalThis.Worker;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  globalThis.Worker = FailingWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "http://localhost/" } });
  try { await body(); }
  finally {
    FailingWorker.current?.terminate();
    FailingWorker.service?.dispose();
    FailingWorker.service = undefined;
    globalThis.Worker = worker;
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

test("filesystem worker load failure rejects startup and wakes descendant requests", async () => {
  await fixture(async () => {
    const fs = new SharedFilesystem();
    const child = new FilesystemClient(fs.fork());
    const request = child.submit("lookup", ["/pending"]);
    const childResult = request.value().catch(error => error);
    const startup = fs.mkdirp("/home/user").catch(error => error);
    try {
      await Promise.resolve();
      FailingWorker.current.crash("module load failed");
      expect((await startup).message).toBe("Filesystem worker failed: module load failed");
      expect((await childResult).errno).toBe(11);
      await expect(fs.flush()).rejects.toThrow("Filesystem worker failed: module load failed");
      expect(() => fs.fork()).toThrow("Filesystem worker failed: module load failed");
      expect(FailingWorker.current.terminated).toBe(true);
    } finally { request.release(); child.dispose(); fs.dispose(); }
  });
}, 3000);

for (const operation of ["flush", "readFile", "lookup", "listFiles"] as const) {
  test(`pending ${operation} reports the worker's failure instead of cancellation errno`, async () => {
    await fixture(async () => {
      const backend = new MemoryBackend();
      let entered!: () => void;
      let finish!: () => void;
      const running = new Promise<void>(resolve => { entered = resolve; });
      const barrier = new Promise<void>(resolve => { finish = resolve; });
      const original = backend.execute.bind(backend);
      backend.execute = async (name, args, bytes) => {
        if (name === operation) { entered(); await barrier; }
        return original(name, args, bytes);
      };
      Object.assign(backend, { flush: async () => { entered(); await barrier; } });
      FailingWorker.service = new FilesystemService(backend);
      const fs = new SharedFilesystem();
      try {
        const pending = fs[operation]("/file").catch(error => error);
        await running;
        FailingWorker.current.crash("filesystem already has a writer");
        expect((await pending).message).toBe("Filesystem worker failed: filesystem already has a writer");
      } finally { finish(); fs.dispose(); }
    });
  }, 3000);
}

test("filesystem worker death cancels an in-flight service operation and all later calls", async () => {
  await fixture(async () => {
    const backend = new MemoryBackend();
    let entered!: () => void;
    let finish!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const original = backend.execute.bind(backend);
    backend.execute = async (operation, args, bytes) => {
      if (operation === "writeFile" && args[0] === "/pending") { entered(); await barrier; }
      return original(operation, args, bytes);
    };
    FailingWorker.service = new FilesystemService(backend);
    const fs = new SharedFilesystem();
    try {
      await fs.writeFile("/existing", "completed before failure");
      const pending = fs.writeFile("/pending", "not acknowledged").catch(error => error);
      await running;
      FailingWorker.current.crash("backend crashed");
      expect((await pending).message).toBe("Filesystem worker failed: backend crashed");
      await expect(fs.readFile("/existing")).rejects.toThrow("Filesystem worker failed: backend crashed");
      await expect(fs.writeFile("/later", "x")).rejects.toThrow("Filesystem worker failed: backend crashed");
      await expect(fs.flush()).rejects.toThrow("Filesystem worker failed: backend crashed");
    } finally { finish(); fs.dispose(); }
  });
}, 3000);
