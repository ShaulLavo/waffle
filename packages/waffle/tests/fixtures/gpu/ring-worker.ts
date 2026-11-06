import type { RingWriter } from "../../../browser/gpu/ring.js";

export type RingWorkerRequest =
  | { readonly action: "hold"; readonly backing: SharedArrayBuffer }
  | { readonly action: "release" }
  | { readonly action: "write-held"; readonly record: Uint8Array }
  | {
      readonly action: "write";
      readonly backing: SharedArrayBuffer;
      readonly record: Uint8Array;
    }
  | {
      readonly action: "pause";
      readonly backing: SharedArrayBuffer;
      readonly record: Uint8Array;
      readonly gate: SharedArrayBuffer;
    }
  | {
      readonly action: "pause-read";
      readonly backing: SharedArrayBuffer;
      readonly gate: SharedArrayBuffer;
    }
  | { readonly action: "authority"; readonly backing: SharedArrayBuffer };

let held: RingWriter | undefined;

function pausePublication(gate: SharedArrayBuffer): () => void {
  const native = Atomics.compareExchange;
  const cells = new Int32Array(gate);
  Object.defineProperty(Atomics, "compareExchange", {
    configurable: true,
    value(
      array: Int32Array | BigInt64Array,
      index: number,
      expected: number | bigint,
      next: number | bigint,
    ) {
      if (
        array instanceof BigInt64Array &&
        typeof expected === "bigint" &&
        typeof next === "bigint"
      ) {
        Atomics.store(cells, 0, 1);
        postMessage("copy-ready");
        if (Atomics.wait(cells, 1, 0, 30_000) === "timed-out")
          throw new Error("publication gate timed out");
        return native(array, index, expected, next);
      }
      if (array instanceof Int32Array && typeof expected === "number" && typeof next === "number")
        return native(array, index, expected, next);
      throw new Error("unexpected publication test atomic");
    },
  });
  return () => Object.defineProperty(Atomics, "compareExchange", { value: native });
}

function pauseRead(gate: SharedArrayBuffer): () => void {
  const native = Atomics.load;
  const cells = new Int32Array(gate);
  let paused = false;
  Object.defineProperty(Atomics, "load", {
    configurable: true,
    value(array: Int32Array | BigInt64Array, index: number) {
      if (array instanceof Int32Array) return native(array, index);
      if (!(array instanceof BigInt64Array)) throw new Error("unexpected reader test atomic");
      const observed = native(array, index);
      if (!paused) {
        paused = true;
        postMessage("read-ready");
        if (Atomics.wait(cells, 1, 0, 30_000) === "timed-out")
          throw new Error("reader gate timed out");
      }
      return observed;
    },
  });
  return () => Object.defineProperty(Atomics, "load", { value: native });
}

function poisonBuiltins(): { readonly hits: () => number; readonly restore: () => void } {
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const fields: [object, PropertyKey][] = [
    [Atomics, "load"],
    [Atomics, "store"],
    [Atomics, "add"],
    [Atomics, "notify"],
    [Atomics, "compareExchange"],
    [Atomics, "wait"],
    [Atomics, "waitAsync"],
    [DataView.prototype, "getUint32"],
    [DataView.prototype, "setUint32"],
    [typedPrototype, "set"],
    [typedPrototype, "subarray"],
    [typedPrototype, "buffer"],
    [typedPrototype, "byteOffset"],
    [typedPrototype, "length"],
    [SharedArrayBuffer.prototype, "byteLength"],
    [SharedArrayBuffer.prototype, "growable"],
    [globalThis, "Uint8Array"],
    [globalThis, "Int32Array"],
    [globalThis, "BigInt64Array"],
    [globalThis, "DataView"],
    [globalThis, "SharedArrayBuffer"],
    [globalThis, "BigInt"],
    [Number, "isInteger"],
    [globalThis, "Number"],
    [Math, "min"],
    [Object, "freeze"],
    [Reflect, "apply"],
  ];
  const saved = fields.map(([target, key]) => ({ target, key, value: descriptor(target, key)! }));
  let hits = 0;
  const deny = () => {
    hits++;
    throw new Error("guest-mutable builtin observed ring operation");
  };
  for (let index = 0; index < saved.length; index++) {
    const entry = saved[index]!;
    const replacement = "get" in entry.value ? { get: deny } : { value: deny };
    define(entry.target, entry.key, { configurable: true, ...replacement });
  }
  return {
    hits: () => hits,
    restore: () => {
      for (let index = 0; index < saved.length; index++) {
        const entry = saved[index]!;
        define(entry.target, entry.key, entry.value);
      }
    },
  };
}

async function authority(backing: SharedArrayBuffer): Promise<void> {
  const { RecordRing } = await import("../../../browser/gpu/ring.js");
  const source = new Uint8Array(16);
  new DataView(source.buffer).setUint32(0, 91, true);
  new DataView(source.buffer).setUint32(4, 16, true);
  source[8] = 71;
  const output = new Uint8Array(16);
  const canary = new Int32Array(backing);
  const poison = poisonBuiltins();
  let checks = 0;
  let result: unknown;
  try {
    try {
      const liveLoad = Reflect.get(Atomics, "load");
      liveLoad(canary, 0);
    } catch {
      /* Positive canary. */
    }
    const before = poison.hits();
    const ring = new RecordRing(backing, 16);
    const acquired = ring.tryAcquireWriter();
    if (acquired.kind !== "acquired") throw new Error("test writer unavailable");
    const written = acquired.writer.tryWrite(source);
    acquired.writer.release();
    const read = ring.readInto(output);
    ring.wait(ring.sequence(), 0, () => {
      checks++;
    });
    const waiting = ring.waitAsync(ring.sequence(), 0);
    if (waiting.async) await waiting.value;
    ring.terminate(73);
    result = {
      written,
      read,
      byte: output[8],
      checks,
      before,
      after: poison.hits(),
      terminal: ring.terminal(),
    };
  } finally {
    poison.restore();
  }
  postMessage(result);
}

async function command(request: RingWorkerRequest): Promise<void> {
  if (request.action === "authority") return authority(request.backing);
  if (request.action === "release") {
    held?.release();
    held = undefined;
    postMessage("released");
    return;
  }
  if (request.action === "write-held") {
    if (!held) throw new Error("test has no held writer");
    postMessage(held.tryWrite(request.record));
    return;
  }
  const restore =
    request.action === "pause"
      ? pausePublication(request.gate)
      : request.action === "pause-read"
        ? pauseRead(request.gate)
        : () => {};
  const { RecordRing } = await import("../../../browser/gpu/ring.js");
  restore();
  const ring = new RecordRing(request.backing, 8);
  if (request.action === "pause-read") {
    postMessage(ring.readInto(new Uint8Array(64)));
    return;
  }
  const acquired = ring.tryAcquireWriter();
  if (acquired.kind !== "acquired") {
    postMessage(acquired);
    return;
  }
  if (request.action === "hold") {
    held = acquired.writer;
    postMessage("held");
    return;
  }
  try {
    postMessage(acquired.writer.tryWrite(request.record));
  } finally {
    acquired.writer.release();
  }
}

self.onmessage = (event: MessageEvent<RingWorkerRequest>) => {
  void command(event.data).catch((error: unknown) => {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
  });
};
