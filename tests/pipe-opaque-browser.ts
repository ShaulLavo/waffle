import { PipeController, PipeErrno } from "../proc/pipes.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function message<T>(worker: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.addEventListener("message", (event) => resolve(event.data), { once: true });
    worker.addEventListener("error", (event) => reject(new Error(event.message)), { once: true });
  });
}
function worker(source: string): Worker {
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  try {
    return new Worker(url, { type: "module" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function runOpaquePipeProof() {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  const pipesUrl = new URL("/pipes.js", location.href).href;
  const readerWorker = worker(`
    const wait = Atomics.wait; let blocked = false;
    Atomics.wait = (...args) => { if (!blocked) { blocked = true; self.postMessage("blocked"); } return wait(...args); };
    const {attachPipeEndpoint} = await import(${JSON.stringify(pipesUrl)});
    self.onmessage = ({data}) => {
      const reader = attachPipeEndpoint(data), bytes = new Uint8Array(1);
      for (;;) { const count = reader.read([bytes]); self.postMessage({count, byte: bytes[0]}); if (count < 1) return; }
    };
    self.postMessage("ready");`);
  let pausedWorker: Worker | undefined;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  try {
    assert((await message(readerWorker)) === "ready", "reader ready");
    const blocked = message(readerWorker);
    readerWorker.postMessage(structuredClone(reader.handle()));
    assert((await blocked) === "blocked", "reader entered actual Atomics.wait before writer reuse");
    const snapshots = [];
    for (let pid = 2; pid < 102; pid++) {
      const result = message<{ count: number; byte: number }>(readerWorker);
      const child = writer.forProcess(pid);
      assert(child.tryWrite([new Uint8Array([65])]) === 1, "child publication");
      child.close();
      const received = await result;
      assert(
        received.count === 1 && received.byte === 65,
        "pre-cloned reader discovers reused writer",
      );
      if (pid === 17 || pid === 101) snapshots.push({ children: pid - 1, ...pipe.resourceUsage });
    }
    const cancelled = message<{ count: number }>(readerWorker);
    reader.revoke();
    assert((await cancelled).count === -PipeErrno.BADF, "blocked reader cancellation");
    pipe.dispose();
    const race = new PipeController({ capacity: 8, maxWriters: 1, maxReaders: 1, relay: "manual" });
    try {
      const receiver = race.retain(1, "read"),
        old = race.retain(2, "write");
      pausedWorker = worker(`
        const compare = Atomics.compareExchange; let paused = false, gate;
        Atomics.compareExchange = (array, index, expected, next) => {
          if (!paused && array instanceof BigInt64Array && array.length === 2 && (next & 0xffffffffn) === 65n) {
            paused = true; self.postMessage("paused"); Atomics.wait(gate, 0, 0);
          }
          return compare(array, index, expected, next);
        };
        const {attachPipeEndpoint} = await import(${JSON.stringify(pipesUrl)});
        self.onmessage = ({data}) => { gate = data.gate; self.postMessage(attachPipeEndpoint(data.endpoint).tryWrite([new Uint8Array([65])])); };
        self.postMessage("ready");`);
      assert((await message(pausedWorker)) === "ready", "paused writer ready");
      const paused = message(pausedWorker);
      pausedWorker.postMessage({ endpoint: structuredClone(old.handle()), gate });
      assert((await paused) === "paused", "old supported write paused before actual payload CAS");
      race.revoke(2);
      const replacement = race.retain(3, "write");
      assert(replacement.tryWrite([new Uint8Array([90])]) === 1, "replacement publication");
      const staleResult = message(pausedWorker);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      assert((await staleResult) === -PipeErrno.BADF, "delayed old write rejected");
      const output = new Uint8Array(1);
      assert(
        receiver.tryRead([output]) === 1 && output[0] === 90,
        "replacement byte survives old CAS",
      );
    } finally {
      race.dispose();
    }
    return { snapshots, cancelled: true, delayedCas: "BADF; replacement byte90 intact" };
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    pausedWorker?.terminate();
    readerWorker.terminate();
    pipe.dispose();
  }
}
