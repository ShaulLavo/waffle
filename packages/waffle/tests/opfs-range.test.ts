import { expect, test } from "bun:test";
import { RangeFixture, pattern, payloadSize } from "./fixtures/opfs-range-storage";

async function fixture(run: (value: RangeFixture) => Promise<void>, sizes?: number[]) {
  const value = new RangeFixture();
  try {
    await value.seed(sizes);
    await run(value);
  } finally {
    await value.cleanup();
  }
}

test("cold 4KiB request reads and allocates only 4KiB of a retained 128MiB payload", () =>
  fixture(async (value) => {
    const owner = await value.open();
    const bytes = await owner.readRange("revision:0", { offset: 65539, length: 4096 });
    expect(bytes.byteLength).toBe(4096);
    expect(value.file().reads.reduce((sum, call) => sum + call.length, 0)).toBe(4096);
    expect(
      Array.from(
        new Set(value.file().reads.map((call) => call.buffer)),
        (buffer) => buffer.byteLength,
      ),
    ).toEqual([4096]);
    expect(bytes[0]).toBe(pattern(65539));
    expect(value.file().reads[0]?.at).toBe(65539);
    expect(value.file().size).toBe(payloadSize);
  }));

function range(
  owner: Awaited<ReturnType<RangeFixture["open"]>>,
  offset = 0,
  length = 4096,
  signal?: AbortSignal,
) {
  return owner.readRange("revision:0", { offset, length, signal });
}

const eofCases: [number, number, number][] = [
  [0, 0, 0],
  [payloadSize, 4, 0],
  [payloadSize + 1, 4, 0],
  [payloadSize - 3, 4096, 3],
];
for (const [offset, length, expected] of eofCases) {
  test(`EOF clips ${offset}+${length} to ${expected}`, () =>
    fixture(async (value) => {
      const bytes = await range(await value.open(), offset, length);
      expect(bytes).toEqual(Uint8Array.from({ length: expected }, (_, i) => pattern(offset + i)));
      expect(value.file().reads.reduce((sum, call) => sum + call.length, 0)).toBe(expected);
    }));
}

for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid range member ${bad} without acquisition`, () =>
    fixture(async (value) => {
      const owner = await value.open();
      await expect(range(owner, bad, 1)).rejects.toBeInstanceOf(RangeError);
      await expect(range(owner, 0, bad)).rejects.toBeInstanceOf(RangeError);
      await expect(range(owner, Number.MAX_SAFE_INTEGER, 1)).rejects.toBeInstanceOf(RangeError);
      expect(value.file().accesses).toHaveLength(0);
    }));
}

test("unknown immutable key is not fabricated", () =>
  fixture(async (value) => {
    const owner = await value.open();
    await expect(owner.readRange("missing", { offset: 0, length: 0 })).rejects.toThrow(
      "Missing filesystem payload",
    );
    expect(value.file().accesses).toHaveLength(0);
  }));

test("native progressing short reads fill exactly one bounded allocation", () =>
  fixture(async (value) => {
    value.file().step = 1000;
    const bytes = await range(await value.open(), 13);
    expect(bytes).toEqual(Uint8Array.from({ length: 4096 }, (_, i) => pattern(13 + i)));
    expect(value.file().reads.map((call) => call.at)).toEqual([13, 1013, 2013, 3013, 4013]);
    expect(new Set(value.file().reads.map((call) => call.buffer)).size).toBe(1);
  }));

for (const progress of [0, -1, 0.5, NaN, Infinity, 4097]) {
  test(`invalid native progress ${progress} is EIO, not a partial success`, () =>
    fixture(async (value) => {
      const owner = await value.open();
      await range(owner, 0, 1);
      const access = value.file().accesses[0]!;
      access.read = () => progress;
      await expect(range(owner)).rejects.toMatchObject({ code: "EIO" });
    }));
}

test("size corruption rejects before native payload allocation/read", () =>
  fixture(async (value) => {
    value.file().size--;
    await expect(range(await value.open())).rejects.toMatchObject({ code: "EIO" });
    expect(value.file().reads).toHaveLength(0);
  }));

test("native read errors retain their cause and cached original handle", () =>
  fixture(async (value) => {
    const failure = new DOMException("unreadable", "NotReadableError");
    value.file().readError = failure;
    const owner = await value.open();
    await expect(range(owner)).rejects.toMatchObject({ code: "EIO", cause: failure });
    const original = value.file().accesses[0]!;
    expect(original.active).toBe(true);
    await owner.close();
    expect(original.closes).toBe(1);
    expect(value.held).toBe(false);
  }));

test("pre-aborted range never opens storage metadata or payload", () =>
  fixture(async (value) => {
    const owner = await value.open();
    const reason = new Error("cancelled before admission");
    await expect(range(owner, 0, 4096, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(value.file().accesses).toHaveLength(0);
  }));

test("cancelled queued range does not acquire another key", () =>
  fixture(
    async (value) => {
      const owner = await value.open();
      const started = value.gate(),
        held = value.gate();
      value.file().acquire = () => {
        started.resolve();
        return held.promise;
      };
      const first = value.track(range(owner));
      await started.promise;
      const abort = new AbortController();
      const reason = new Error("cancel queued");
      const queued = value.track(
        owner.readRange("revision:1", { offset: 0, length: 1, signal: abort.signal }),
      );
      abort.abort(reason);
      held.resolve();
      await first;
      await expect(queued).rejects.toBe(reason);
      expect(value.file("revision:1").accesses).toHaveLength(0);
    },
    [payloadSize, 3],
  ));

test("cancelled file lookup never starts native acquisition", () =>
  fixture(async (value) => {
    const owner = await value.open();
    const started = value.gate(),
      held = value.gate();
    value.file().lookup = () => {
      started.resolve();
      return held.promise;
    };
    const abort = new AbortController();
    const reading = value.track(range(owner, 0, 4096, abort.signal));
    await started.promise;
    abort.abort();
    held.resolve();
    await expect(reading).rejects.toBe(abort.signal.reason);
    expect(value.file().accesses).toHaveLength(0);
  }));

test("abort during admitted acquisition joins the exact late handle before close", () =>
  fixture(async (value) => {
    const owner = await value.open();
    const started = value.gate(),
      held = value.gate();
    value.file().acquire = () => {
      started.resolve();
      return held.promise;
    };
    const abort = new AbortController();
    const reading = value.track(range(owner, 0, 4096, abort.signal));
    await started.promise;
    abort.abort();
    let closed = false;
    const closing = value.track(
      owner.close().then(() => {
        closed = true;
      }),
    );
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(value.held).toBe(true);
    held.resolve();
    await expect(reading).rejects.toBe(abort.signal.reason);
    await closing;
    const original = value.file().accesses[0]!;
    expect(value.file().accesses).toHaveLength(1);
    expect(value.file().reads).toHaveLength(0);
    expect(original.active).toBe(false);
    expect(original.closes).toBe(1);
    expect(value.releases).toBe(1);
  }));

test("abort in a short native read prevents the next read and preserves exact reason", () =>
  fixture(async (value) => {
    const owner = await value.open();
    const abort = new AbortController();
    value.file().step = 1;
    value.file().onRead = () => abort.abort(0);
    await expect(range(owner, 0, 4096, abort.signal)).rejects.toBe(0);
    expect(value.file().reads).toHaveLength(1);
    await owner.close();
    expect(value.file().accesses[0]?.closes).toBe(1);
  }));

test("abort after a complete native read does not return success", () =>
  fixture(async (value) => {
    const abort = new AbortController();
    const reason = new Error("cancel complete native read");
    value.file().onRead = () => abort.abort(reason);
    await expect(range(await value.open(), 0, 4096, abort.signal)).rejects.toBe(reason);
  }));

test("abort from acquisition failure prevents retry", () =>
  fixture(async (value) => {
    const abort = new AbortController();
    let attempts = 0;
    const reason = new Error("cancel failed acquisition");
    value.file().acquire = async () => {
      attempts++;
      abort.abort(reason);
      throw new DOMException("busy", "NoModificationAllowedError");
    };
    await expect(range(await value.open(), 0, 4096, abort.signal)).rejects.toBe(reason);
    expect(attempts).toBe(1);
  }));

test("range handles obey eviction and retained snapshots keep distinct immutable keys", () =>
  fixture(
    async (value) => {
      const owner = await value.open();
      await range(owner);
      const original = value.file().accesses[0]!;
      expect(await owner.readRange("revision:1", { offset: 1, length: 2 })).toEqual(
        new Uint8Array([pattern(1), pattern(2)]),
      );
      expect(original.closes).toBe(1);
      await range(owner, 7, 2);
      expect(value.file().accesses).toHaveLength(2);
      expect(owner.resources().opfsPeakHandles).toBe(1);
      await owner.close();
      expect(value.file().accesses.every((access) => !access.active)).toBe(true);
    },
    [payloadSize, 3],
  ));

for (const reason of [new Error("close fails"), undefined, null, false, 0, ""]) {
  test(`range close failure retains original and one-shot reason ${String(reason)}`, () =>
    fixture(async (value) => {
      const owner = await value.open();
      await range(owner);
      const original = value.file().accesses[0]!;
      original.fault = { reason };
      const closing = value.track(owner.close());
      await expect(closing).rejects.toBe(reason);
      expect(owner.close()).toBe(closing);
      expect(original.active).toBe(true);
      expect(original.closes).toBe(1);
      expect(owner.resources().opfsHandles).toBe(1);
      expect(value.held).toBe(true);
      expect(value.releases).toBe(0);
      await expect(range(owner)).rejects.toThrow("closed");
    }));
}

test("full read still returns the entire immutable payload after a range", () =>
  fixture(
    async (value) => {
      const owner = await value.open();
      await range(owner, 3, 2);
      const bytes = await owner.read("revision:0");
      expect(bytes).toEqual(Uint8Array.from({ length: 19 }, (_, i) => pattern(i)));
      expect(value.file().accesses).toHaveLength(1);
    },
    [19],
  ));

test("aborted late acquisition keeps a failed original close and workspace lock", () =>
  fixture(async (value) => {
    const owner = await value.open();
    const started = value.gate(),
      held = value.gate();
    value.file().acquire = () => {
      started.resolve();
      return held.promise;
    };
    const reason = new Error("late original close failure");
    value.file().opened = (access) => {
      access.fault = { reason };
    };
    const abort = new AbortController();
    const reading = value.track(range(owner, 0, 4096, abort.signal));
    await started.promise;
    abort.abort();
    const closing = value.track(owner.close());
    held.resolve();
    await expect(reading).rejects.toBe(abort.signal.reason);
    await expect(closing).rejects.toBe(reason);
    expect(value.file().accesses).toHaveLength(1);
    expect(value.file().accesses[0]?.closes).toBe(1);
    expect(value.file().accesses[0]?.active).toBe(true);
    expect(owner.resources().opfsHandles).toBe(1);
    expect(value.held).toBe(true);
    expect(value.releases).toBe(0);
    expect(owner.close()).toBe(closing);
  }));

test("range eviction failure poisons admission without opening a replacement", () =>
  fixture(
    async (value) => {
      const owner = await value.open();
      await range(owner);
      const original = value.file().accesses[0]!;
      const reason = new Error("original eviction close failure");
      original.fault = { reason };
      await expect(owner.readRange("revision:1", { offset: 0, length: 1 })).rejects.toMatchObject({
        cause: reason,
      });
      expect(value.file("revision:1").accesses).toHaveLength(0);
      await expect(value.track(owner.close())).rejects.toBe(reason);
      expect(original.closes).toBe(1);
      expect(value.held).toBe(true);
    },
    [payloadSize, 3],
  ));
