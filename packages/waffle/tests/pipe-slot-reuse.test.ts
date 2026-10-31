import { afterEach, expect, test } from "bun:test";
import { isolatedPipes } from "./fixtures/pipes-intrinsics.ts";
import type { PipeEndpointHandle } from "../proc/pipes.js";

const { pipes, atomics: A, hooks } = isolatedPipes();
const { PipeController, PipeErrno, PipePublicationRegistry, attachPipeEndpoint } = pipes;
const controllers: InstanceType<typeof PipeController>[] = [];
const STOP = 1n << 32n;
const byte = new Uint8Array([123]);

function fixture(maxWriters = 1, capacity = 8) {
  const pipe = new PipeController({ maxWriters, capacity, relay: "manual" });
  controllers.push(pipe);
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(2, "write");
  return { pipe, reader, writer };
}
function words(handle: PipeEndpointHandle) {
  const stride = 40 + handle.capacity + Math.min(handle.capacity, 1024) * 16;
  const offset = 40 + handle.slot * stride;
  return {
    owner: new Int32Array(handle.buffer, offset, 1),
    refs: new Int32Array(handle.buffer, offset + 4, 1),
    published: new BigInt64Array(handle.buffer, offset + 8, 1),
    consumed: new BigInt64Array(handle.buffer, offset + 16, 1),
    epoch: new Int32Array(handle.buffer, offset + 36, 1),
  };
}
function fence(handle: PipeEndpointHandle, owner: number, refs: number, epoch: number) {
  const view = words(handle);
  expect(Atomics.load(view.owner, 0)).toBe(owner);
  expect(Atomics.load(view.refs, 0)).toBe(refs);
  expect(Atomics.load(view.epoch, 0)).toBe(epoch);
}
function sameWord(a: ArrayBufferView, b: ArrayBufferView) {
  return a.buffer === b.buffer && a.byteOffset === b.byteOffset;
}
function readByte(reader: ReturnType<typeof fixture>["reader"], value = 123) {
  const output = new Uint8Array(1);
  expect(reader.tryRead([output])).toBe(1);
  expect(output[0]).toBe(value);
}
afterEach(() => {
  for (const pipe of controllers.splice(0)) pipe.dispose();
});

for (const action of ["close", "revoke"] as const) {
  test(`payload copy ${action} quarantines its active incarnation until it leaves`, () => {
    const { pipe, reader, writer } = fixture();
    const handle = writer.handle();
    const subarray = hooks.typedArraySubarray;
    let paused = false;
    hooks.typedArraySubarray = (view, begin, end) => {
      if (view !== byte || paused) return subarray(view, begin, end);
      paused = true;
      if (action === "close") writer.close();
      else pipe.revoke(2);
      fence(handle, 2, action === "close" ? 0 : -1, 1);
      expect(() => pipe.retain(3, "write")).toThrow("busy");
      return subarray(view, begin, end);
    };
    try {
      expect(writer.tryWrite([byte])).toBe(-PipeErrno.BADF);
    } finally {
      hooks.typedArraySubarray = subarray;
    }
    expect(paused).toBe(true);
    fence(handle, 2, action === "close" ? 0 : -1, 0);
    const next = pipe.retain(3, "write");
    fence(handle, 3, 1, 256);
    expect(next.handle().incarnation).toBe(1);
    expect(next.tryWrite([byte])).toBe(1);
    readByte(reader);
  });
}

for (const phase of ["before-revoke", "after-revoke"] as const) {
  test(`publication CAS paused ${phase} cannot race reuse`, () => {
    const { pipe, reader, writer } = fixture();
    const handle = writer.handle(),
      state = words(handle),
      cas = A.compareExchange;
    let paused = false;
    A.compareExchange = ((array: BigInt64Array, index: number, old: bigint, next: bigint) => {
      if (!paused && sameWord(array, state.published)) {
        paused = true;
        if (phase === "before-revoke") fence(handle, 2, 1, 1);
        pipe.revoke(2);
        fence(handle, 2, -1, 1);
        expect(() => pipe.retain(3, "write")).toThrow("busy");
      }
      return cas(array, index, old, next);
    }) as typeof A.compareExchange;
    try {
      expect(writer.tryWrite([byte])).toBe(-PipeErrno.BADF);
    } finally {
      A.compareExchange = cas;
    }
    expect(paused).toBe(true);
    fence(handle, 2, -1, 0);
    const next = pipe.retain(3, "write");
    fence(handle, 3, 1, 256);
    expect(next.tryWrite([byte])).toBe(1);
    readByte(reader);
  });
}

test("stale handles, delayed close and late pid revocation cannot touch a replacement", () => {
  const { pipe, reader, writer } = fixture();
  const stale = attachPipeEndpoint(structuredClone(writer.handle()));
  pipe.revoke(2);
  const next = pipe.retain(3, "write");
  fence(next.handle(), 3, 1, 256);
  expect(stale.tryWrite([byte])).toBe(-PipeErrno.BADF);
  expect(stale.readiness().hangup).toBe(true);
  expect(() => stale.forProcess(4)).toThrow("closed");
  expect(() => pipe.duplicate(stale)).toThrow("closed");
  stale.close();
  writer.close();
  pipe.revoke(2);
  fence(next.handle(), 3, 1, 256);
  expect(Atomics.load(words(next.handle()).published, 0) & STOP).toBe(0n);
  expect(next.tryWrite([byte])).toBe(1);
  readByte(reader);
});

test("registry-backed late revoke and collection retain old-pid revocation", () => {
  const registry = new PipePublicationRegistry();
  registry.registerProcess(1);
  registry.registerProcess(2);
  registry.registerProcess(3);
  const pipe = new PipeController({ maxWriters: 1, registry, relay: "manual" });
  controllers.push(pipe);
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(2, "write");
  registry.collectProcess(2);
  const next = pipe.retain(3, "write");
  writer.close();
  pipe.revoke(2);
  registry.revoke(2);
  registry.collectProcess(2);
  expect(() => pipe.retain(2, "write")).toThrow("revoked");
  fence(next.handle(), 3, 1, 256);
  expect(next.tryWrite([byte])).toBe(1);
  readByte(reader);
  registry.collectProcess(1);
  registry.collectProcess(3);
});

test("registry-less tombstones do not remember reclaimed historical pids", () => {
  const { pipe, writer } = fixture();
  pipe.revoke(2);
  const next = pipe.retain(3, "write");
  next.close();
  const historical = pipe.retain(2, "write");
  expect(historical.handle().incarnation).toBe(2);
  expect(writer.tryWrite([byte])).toBe(-PipeErrno.BADF);
});

test("reclaim refs CAS cannot overwrite a concurrent revocation", () => {
  const { pipe, writer } = fixture();
  writer.close();
  const state = words(writer.handle()),
    cas = A.compareExchange;
  let revoked = false;
  A.compareExchange = ((array: Int32Array, index: number, old: number, next: number) => {
    if (!revoked && sameWord(array, state.refs) && old === 0 && next === 1) {
      revoked = true;
      pipe.revoke(3);
    }
    return cas(array, index, old, next);
  }) as typeof A.compareExchange;
  try {
    expect(() => pipe.retain(3, "write")).toThrow("revoked");
  } finally {
    A.compareExchange = cas;
  }
  expect(revoked).toBe(true);
  fence(writer.handle(), 3, -1, 256);
  expect(Atomics.load(state.published, 0) & STOP).toBe(STOP);
  const next = pipe.retain(4, "write");
  fence(next.handle(), 4, 1, 512);
});

for (const phase of ["reopen", "reservation", "admission", "references", "published"] as const) {
  test(`EOF stays open at reclaim ${phase}`, () => {
    const { pipe, reader, writer } = fixture(2);
    const parent = pipe.retain(3, "write");
    writer.close();
    const state = words(writer.handle()),
      store = A.store,
      cas = A.compareExchange;
    let observed = false;
    function observe() {
      if (observed) return;
      observed = true;
      parent.close();
      expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
      expect(Atomics.load(state.epoch, 0)).toBe(256);
    }
    A.store = ((array: Int32Array | BigInt64Array, index: number, value: never) => {
      const result = store(array as Int32Array, index, value);
      const match =
        (phase === "reopen" && sameWord(array, state.published)) ||
        (phase === "reservation" && sameWord(array, state.owner) && value === -4) ||
        (phase === "published" && sameWord(array, state.owner) && value === 4);
      if (match) observe();
      return result;
    }) as typeof A.store;
    A.compareExchange = ((array: Int32Array, index: number, old: number, next: number) => {
      const result = cas(array, index, old, next);
      if (phase === "references" && sameWord(array, state.refs) && next === 1) observe();
      if (
        phase === "admission" &&
        array.buffer === state.owner.buffer &&
        array.byteOffset === 0 &&
        index === 5
      )
        observe();
      return result;
    }) as typeof A.compareExchange;
    let next: ReturnType<typeof pipe.retain>;
    try {
      next = pipe.retain(4, "write");
    } finally {
      A.store = store;
      A.compareExchange = cas;
    }
    expect(observed).toBe(true);
    fence(next.handle(), 4, 1, 256);
    next.close();
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  });
}

test("retirement during reopen aborts into a fenced closed tombstone", () => {
  const { pipe, writer } = fixture();
  writer.close();
  const state = words(writer.handle()),
    store = A.store;
  let retired = false;
  A.store = ((array: BigInt64Array, index: number, value: bigint) => {
    const result = store(array, index, value);
    if (!retired && sameWord(array, state.published) && !(value & STOP)) {
      retired = true;
      Atomics.store(new Int32Array(writer.handle().buffer, 0, 6), 5, -1);
    }
    return result;
  }) as typeof A.store;
  try {
    expect(() => pipe.retain(3, "write")).toThrow("closed");
  } finally {
    A.store = store;
  }
  expect(retired).toBe(true);
  fence(writer.handle(), 3, -1, 256);
  expect(Atomics.load(state.published, 0) & STOP).toBe(STOP);
});

test("concurrent writer limit leaves all occupied words unchanged", () => {
  const { pipe, writer } = fixture(16);
  const live = [writer];
  for (let pid = 3; pid < 18; pid++) live.push(pipe.retain(pid, "write"));
  const before = live.map((endpoint) => {
    const state = words(endpoint.handle());
    return [
      Atomics.load(state.owner, 0),
      Atomics.load(state.refs, 0),
      Atomics.load(state.epoch, 0),
    ];
  });
  expect(() => pipe.retain(18, "write")).toThrow("16 slots");
  live.forEach((endpoint, index) =>
    fence(endpoint.handle(), before[index]![0]!, before[index]![1]!, before[index]![2]!),
  );
});

test("50 sequential closed writers append before a delayed reader drains", () => {
  const { pipe, reader, writer } = fixture(1, 64);
  const original = words(writer.handle());
  expect(writer.tryWrite([new Uint8Array([0])])).toBe(1);
  writer.close();
  for (let pid = 3; pid < 53; pid++) {
    const next = pipe.retain(pid, "write");
    expect(next.tryWrite([new Uint8Array([pid - 2])])).toBe(1);
    fence(next.handle(), pid, 1, (pid - 2) * 256);
    next.close();
  }
  expect(Atomics.load(original.consumed, 0)).toBe(0n);
  expect(Atomics.load(original.published, 0) & 0xffffffffn).toBe(51n);
  for (let value = 0; value <= 50; value++) readByte(reader, value);
  expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
});

test("append reclaim preserves a pinned old record and global ticket order", () => {
  const { pipe, reader, writer } = fixture(2, 16);
  const parent = pipe.retain(3, "write");
  expect(writer.tryWrite([new Uint8Array([10, 11])])).toBe(2);
  readByte(reader, 10);
  const selection = new BigInt64Array(writer.handle().buffer, 32, 1);
  const pin = Atomics.load(selection, 0);
  const consumed = Atomics.load(words(writer.handle()).consumed, 0);
  writer.close();
  const next = pipe.retain(4, "write");
  expect(Atomics.load(selection, 0)).toBe(pin);
  expect(Atomics.load(words(next.handle()).consumed, 0)).toBe(consumed);
  expect(parent.tryWrite([new Uint8Array([12])])).toBe(1);
  expect(next.tryWrite([new Uint8Array([13])])).toBe(1);
  readByte(reader, 11);
  readByte(reader, 12);
  readByte(reader, 13);
  fence(next.handle(), 4, 1, 256);
});

test("append reclaim clears an abandoned consumed record pin without resetting cursors", () => {
  const { pipe, reader, writer } = fixture();
  expect(writer.tryWrite([byte])).toBe(1);
  readByte(reader);
  writer.close();
  const next = pipe.retain(3, "write");
  const selection = new BigInt64Array(writer.handle().buffer, 32, 1);
  Atomics.store(selection, 0, 1n);
  expect(next.tryWrite([byte])).toBe(1);
  readByte(reader);
  expect(Atomics.load(selection, 0)).toBe(0n);
});

test("incarnations never wrap, and active section overflow is explicit", () => {
  const { pipe, writer } = fixture();
  const state = words(writer.handle());
  Atomics.store(state.epoch, 0, 255);
  expect(() => writer.tryWrite([byte])).toThrow("active section limit");
  expect(Atomics.load(state.epoch, 0)).toBe(255);
  Atomics.store(state.epoch, 0, 0);
  writer.close();
  Atomics.store(state.epoch, 0, 0x7fffff00);
  expect(() => pipe.retain(3, "write")).toThrow("incarnation-exhausted");
  fence(writer.handle(), 2, 0, 0x7fffff00);
});

test("continued byte and record cursors wrap across a drained reclaim", () => {
  const { pipe, reader, writer } = fixture();
  const state = words(writer.handle());
  const cursor = 0xfffffffen | (0x1fffffffn << 34n);
  Atomics.store(state.published, 0, cursor);
  Atomics.store(state.consumed, 0, cursor);
  writer.close();
  const next = pipe.retain(3, "write");
  expect(Atomics.load(state.published, 0)).toBe(cursor);
  expect(next.tryWrite([new Uint8Array([1, 2, 3, 4])])).toBe(4);
  const output = new Uint8Array(4);
  expect(reader.tryRead([output])).toBe(4);
  expect(output).toEqual(new Uint8Array([1, 2, 3, 4]));
  fence(next.handle(), 3, 1, 256);
});

test("reused writers preserve atomic writes, backpressure and independent description flags", () => {
  const { pipe, reader, writer } = fixture(1, 8192);
  writer.fdflags = 4;
  writer.close();
  const next = pipe.retain(3, "write"),
    alias = pipe.duplicate(next);
  expect(next.fdflags).toBe(0);
  alias.fdflags = 4;
  expect(next.fdflags).toBe(4);
  expect(next.tryWrite([new Uint8Array(5000)])).toBe(5000);
  expect(next.tryWrite([new Uint8Array(4096)])).toBe(-PipeErrno.AGAIN);
  expect(next.tryWrite([new Uint8Array(5000)])).toBe(3192);
  expect(next.readiness().writable).toBe(false);
  expect(next.tryWrite([byte])).toBe(-PipeErrno.AGAIN);
  expect(reader.tryRead([new Uint8Array(5000)])).toBe(5000);
  expect(next.readiness().writable).toBe(true);
  fence(next.handle(), 3, 2, 256);
});

for (const phase of ["reclaiming", "reserving"] as const) {
  test(`append reuse exposes committed records while the slot is ${phase}`, () => {
    const { pipe, reader, writer } = fixture(2, 16);
    const parent = pipe.retain(3, "write");
    expect(writer.tryWrite([new Uint8Array([10])])).toBe(1);
    writer.close();
    expect(parent.tryWrite([new Uint8Array([20])])).toBe(1);
    const state = words(writer.handle()),
      cas = A.compareExchange,
      store = A.store;
    let observed = false;
    function observe() {
      if (observed) return;
      observed = true;
      fence(
        writer.handle(),
        phase === "reclaiming" ? -0x80000000 : -4,
        0,
        phase === "reclaiming" ? 0 : 256,
      );
      const queued = reader.readiness().nbytes;
      readByte(reader, 10);
      expect(queued).toBe(2);
    }
    A.compareExchange = ((array: Int32Array, index: number, old: number, next: number) => {
      const result = cas(array, index, old, next);
      if (phase === "reclaiming" && sameWord(array, state.owner) && next === -0x80000000) observe();
      return result;
    }) as typeof A.compareExchange;
    A.store = ((array: Int32Array, index: number, value: number) => {
      const result = store(array, index, value);
      if (phase === "reserving" && sameWord(array, state.owner) && value === -4) observe();
      return result;
    }) as typeof A.store;
    try {
      pipe.retain(4, "write");
    } finally {
      A.compareExchange = cas;
      A.store = store;
    }
    expect(observed).toBe(true);
    readByte(reader, 20);
  });
}

test("completed-before-started order survives a scan paused on a reused ring", () => {
  const { pipe, reader, writer } = fixture(2, 16);
  const later = pipe.retain(3, "write");
  writer.close();
  const next = pipe.retain(4, "write");
  const state = words(next.handle()),
    load = A.load;
  let inserted = false;
  A.load = ((array: BigInt64Array, index: number) => {
    const value = load(array, index);
    if (!inserted && sameWord(array, state.published)) {
      inserted = true;
      fence(next.handle(), 4, 1, 256);
      expect(next.tryWrite([new Uint8Array([10])])).toBe(1);
      expect(later.tryWrite([new Uint8Array([20])])).toBe(1);
    }
    return value;
  }) as typeof A.load;
  try {
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  } finally {
    A.load = load;
  }
  expect(inserted).toBe(true);
  readByte(reader, 10);
  readByte(reader, 20);
});

test("pid revocation holds its section through owner observation and mutation", () => {
  const { pipe, writer } = fixture();
  const state = words(writer.handle()),
    load = A.load;
  let paused = false;
  A.load = ((array: Int32Array, index: number) => {
    const value = load(array, index);
    if (!paused && sameWord(array, state.owner) && Atomics.load(state.epoch, 0) === 1) {
      paused = true;
      writer.close();
      fence(writer.handle(), 2, 0, 1);
      expect(() => pipe.retain(3, "write")).toThrow("busy");
    }
    return value;
  }) as typeof A.load;
  try {
    pipe.revoke(2);
  } finally {
    A.load = load;
  }
  expect(paused).toBe(true);
  fence(writer.handle(), 2, -1, 0);
  const next = pipe.retain(3, "write");
  fence(next.handle(), 3, 1, 256);
});

test("the pre-reopen reservation window retains the existing fresh-slot EOF contract", () => {
  const { pipe, reader, writer } = fixture(2);
  const parent = pipe.retain(3, "write");
  writer.close();
  const state = words(writer.handle()),
    cas = A.compareExchange;
  let observed = false;
  A.compareExchange = ((array: Int32Array, index: number, old: number, next: number) => {
    const result = cas(array, index, old, next);
    if (!observed && sameWord(array, state.owner) && next === -0x80000000) {
      observed = true;
      parent.close();
      expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
      fence(writer.handle(), -0x80000000, 0, 0);
    }
    return result;
  }) as typeof A.compareExchange;
  try {
    const next = pipe.retain(4, "write");
    expect(next.tryWrite([byte])).toBe(1);
    readByte(reader);
  } finally {
    A.compareExchange = cas;
  }
  expect(observed).toBe(true);
});
