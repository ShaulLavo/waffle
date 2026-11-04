import { expect, test } from "bun:test";
import { PipeController, PipeErrno } from "../proc/pipes.js";

function message(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("pipe reuse worker timed out")), 5000);
    const onMessage = (event: MessageEvent<unknown>) => finish(undefined, event.data);
    const onError = (event: ErrorEvent) => finish(event.error ?? new Error(event.message));
    function finish(error?: unknown, value?: unknown) {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve(value);
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}
function worker() {
  return new Worker(new URL("./fixtures/pipe-reuse-worker.ts", import.meta.url));
}

async function progress(gate: Int32Array, target: number): Promise<void> {
  for (;;) {
    const observed = Atomics.load(gate, 0);
    if (observed >= target) return;
    await Atomics.waitAsync(gate, 0, observed).value;
  }
}

test("a pre-cloned blocked Bun Worker reads 3001 reused writer lifetimes", async () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read"),
    root = pipe.retain(2, "write");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const child = worker();
  try {
    const ready = message(child);
    child.postMessage({ handle: structuredClone(reader.handle()), gate, operation: "read" });
    expect(await ready).toBe("ready");
    const completed = message(child);
    for (let pid = 3; pid < 3004; pid++) {
      const writer = root.forProcess(pid);
      expect(writer.tryWrite([new Uint8Array([123])])).toBe(1);
      await progress(gate, pid - 2);
      writer.close();
    }
    pipe.revoke(1);
    expect(await completed).toBe(3001);
    expect(root.handle().buffer.byteLength).toBe(2622760);
  } finally {
    pipe.revoke(1);
    await child.terminate();
    pipe.dispose();
  }
}, 15000);

for (const terminate of [false, true]) {
  test(`a physically paused Bun Worker ${terminate ? "death quarantines" : "release fences"} its writer slot`, async () => {
    const pipe = new PipeController({
      capacity: 8,
      maxWriters: terminate ? 2 : 1,
      relay: "manual",
    });
    const reader = pipe.retain(1, "read"),
      writer = pipe.retain(2, "write");
    const other = terminate ? pipe.retain(3, "write") : undefined;
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const handle = writer.handle();
    const offset = 40 + handle.slot * (40 + 8 + 8 * 16);
    const epoch = new Int32Array(handle.buffer, offset + 36, 1);
    const owner = new Int32Array(handle.buffer, offset, 1);
    const refs = new Int32Array(handle.buffer, offset + 4, 1);
    const child = worker();
    try {
      const paused = message(child);
      child.postMessage({ handle: structuredClone(handle), gate, operation: "pause" });
      expect(await paused).toBe("paused");
      expect(Atomics.load(epoch, 0)).toBe(1);
      pipe.revoke(2);
      expect(() => pipe.retain(4, "write")).toThrow("busy");
      expect(Atomics.load(owner, 0)).toBe(2);
      expect(Atomics.load(refs, 0)).toBe(-1);
      if (terminate) await child.terminate();
      else {
        const done = message(child);
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        expect(await done).toBe(-PipeErrno.BADF);
      }
      expect(Atomics.load(epoch, 0)).toBe(terminate ? 1 : 0);
      other?.close();
      for (let pid = 4; pid < 24; pid++) {
        const next = pipe.retain(pid, "write");
        expect(next.tryWrite([new Uint8Array([123])])).toBe(1);
        const output = new Uint8Array(1);
        expect(reader.tryRead([output])).toBe(1);
        expect(output[0]).toBe(123);
        next.close();
      }
      expect(Atomics.load(epoch, 0)).toBe(terminate ? 1 : 20 * 256);
    } finally {
      if (!terminate) {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
      }
      await child.terminate();
      pipe.dispose();
    }
  });
}
