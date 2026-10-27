import { expect, spyOn, test } from "bun:test";
import { MAX_RECORD } from "../browser/net/protocol.js";
import { CAPACITY, createRing, RingReader, RingWriter } from "../browser/net/ring.js";

const WRITE = 1;
const READ = 2;
const SPACE = 3;
const RECORD_HEADER = 12;
const modes = ["waitAsync", "fallback"] as const;
type Mode = (typeof modes)[number];

function invokeCapturedTimer(callback: unknown): void {
  if (typeof callback !== "function") throw new Error("Expected a timer callback");
  callback();
}

function fixture(mode: Mode) {
  const sab = createRing();
  const writer = new RingWriter(sab);
  const reader = new RingReader(sab);
  const cells = new Int32Array(sab, 0, 8);
  const descriptor = Object.getOwnPropertyDescriptor(Atomics, "waitAsync");
  const nativeWaitAsync: unknown = Reflect.get(Atomics, "waitAsync");
  if (typeof nativeWaitAsync !== "function") throw new Error("Native waitAsync is required");
  let waits = 0;
  const waitWithoutTimeout = (word: Int32Array, index: number, seen: number) => {
    waits++;
    return nativeWaitAsync(word, index, seen, Infinity);
  };
  const timerHandle = setTimeout(() => {}, 2_147_483_647);
  timerHandle.unref();
  const timer = spyOn(globalThis, "setTimeout").mockReturnValue(timerHandle);
  Object.defineProperty(Atomics, "waitAsync", {
    configurable: true,
    writable: true,
    value: mode === "waitAsync" ? waitWithoutTimeout : undefined,
  });
  let releasedTimers = 0;
  const releaseTimers = () => {
    const scheduled = timer.mock.calls.slice(releasedTimers);
    releasedTimers = timer.mock.calls.length;
    for (const [callback] of scheduled) invokeCapturedTimer(callback);
  };
  return {
    sab,
    cells,
    writer,
    reader,
    timer,
    waits: () => waits,
    releaseTimers,
    close() {
      writer.dispose();
      releaseTimers();
      timer.mockRestore();
      clearTimeout(timerHandle);
      if (descriptor) Object.defineProperty(Atomics, "waitAsync", descriptor);
      else Reflect.deleteProperty(Atomics, "waitAsync");
    },
  };
}

async function fillRing(f: ReturnType<typeof fixture>) {
  const payload = new Uint8Array(MAX_RECORD).fill(7);
  const count = Math.floor(CAPACITY / (MAX_RECORD + RECORD_HEADER));
  for (let id = 0; id < count; id++) await f.writer.write(id, 2, payload);
  const remaining = CAPACITY - count * (MAX_RECORD + RECORD_HEADER) - RECORD_HEADER;
  await f.writer.write(count, 2, payload.subarray(0, remaining));
  expect(Atomics.load(f.cells, WRITE) - Atomics.load(f.cells, READ)).toBe(CAPACITY);
  return count + 1;
}

function checkpoint(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadWithDrain(
  f: ReturnType<typeof fixture>,
  capture: (records: ReturnType<RingReader["drain"]>) => void,
): typeof Atomics.load {
  let injectDrain = true;
  return new Proxy(Atomics.load, {
    apply(target, receiver, args) {
      const seen = Reflect.apply(target, receiver, args);
      const [word, index] = args;
      if (!(word instanceof Int32Array) || word.buffer !== f.sab || index !== READ || !injectDrain)
        return seen;
      injectDrain = false;
      capture(f.reader.drain());
      return seen;
    },
  });
}

async function drainInterleaving(mode: Mode) {
  const f = fixture(mode);
  let drained: ReturnType<RingReader["drain"]> = [];
  let pending = Promise.resolve();
  let completed = false;
  let hook: { mockRestore(): void } | undefined;
  try {
    const filled = await fillRing(f);
    const load = loadWithDrain(f, (records) => {
      drained = records;
    });
    hook = spyOn(Atomics, "load").mockImplementation(load);
    const payload = new Uint8Array([1, 2, 3]);
    pending = Promise.all([
      f.writer.write(filled, 3, payload),
      f.writer.write(filled + 1, 4, payload),
    ]).then(() => {
      completed = true;
    });
    await checkpoint();
    expect(drained.map((record) => record.handle)).toEqual(
      Array.from({ length: filled }, (_, id) => id),
    );
    expect(Atomics.load(f.cells, SPACE)).toBe(1);
    expect(completed).toBe(true);
    expect(f.waits()).toBe(0);
    expect(f.timer).not.toHaveBeenCalled();
    expect(f.reader.drain()).toEqual([
      { handle: filled, kind: 3, payload },
      { handle: filled + 1, kind: 4, payload },
    ]);
  } finally {
    hook?.mockRestore();
    f.close();
    await pending;
  }
}

async function fullRing(mode: Mode, dispose: boolean) {
  const f = fixture(mode);
  let pending = Promise.resolve();
  let completed = false;
  try {
    const filled = await fillRing(f);
    const written = Atomics.load(f.cells, WRITE);
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    pending = Promise.all([
      f.writer.write(filled, 3, payload),
      f.writer.write(filled + 1, 4, payload),
    ]).then(() => {
      completed = true;
    });
    await checkpoint();
    expect(completed).toBe(false);
    expect(Atomics.load(f.cells, WRITE)).toBe(written);
    expect(f.waits()).toBe(mode === "waitAsync" ? 1 : 0);
    expect(f.timer.mock.calls).toHaveLength(mode === "fallback" ? 1 : 0);
    if (dispose) {
      f.writer.dispose();
      f.releaseTimers();
      await pending;
      expect(Atomics.load(f.cells, WRITE)).toBe(written);
    }
    const drained = f.reader.drain();
    expect(drained.map((record) => record.handle)).toEqual(
      Array.from({ length: filled }, (_, id) => id),
    );
    expect(drained.every((record) => record.payload.every((byte) => byte === 7))).toBe(true);
    f.releaseTimers();
    await pending;
    if (dispose) await f.writer.write(filled + 2, 5, payload);
    const expected = dispose
      ? []
      : [
          { handle: filled, kind: 3, payload },
          { handle: filled + 1, kind: 4, payload },
        ];
    expect(f.reader.drain()).toEqual(expected);
  } finally {
    f.close();
    await pending;
  }
}

for (const mode of modes) {
  test(`ring progresses after a drain at the stale full check without another wake or timeout: ${mode}`, () =>
    drainInterleaving(mode));
  test(`ring bounds capacity and preserves queued FIFO records across wrap: ${mode}`, () =>
    fullRing(mode, false));
  test(`ring disposal releases full-ring writes and drops queued and later records: ${mode}`, () =>
    fullRing(mode, true));
}
