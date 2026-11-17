import { expect, test } from "bun:test";
import { RangeFixture, pattern } from "./fixtures/opfs-range-storage";

async function fixture(run: (value: RangeFixture) => Promise<void>) {
  const value = new RangeFixture();
  try {
    await value.seed([32]);
    await run(value);
  } finally {
    await value.cleanup();
  }
}

async function retained(value: RangeFixture) {
  const owner = await value.open();
  await owner.load();
  const retention = owner.retainPayload("revision:0", 32);
  return { owner, retention };
}

for (const stage of ["snapshotGet", "snapshotRead"] as const) {
  test(`retained OPFS retries native invalidation at ${stage} with a fresh snapshot`, () =>
    fixture(async (value) => {
      const { owner, retention } = await retained(value);
      let attempts = 0;
      value.file()[stage] = async () => {
        if (++attempts === 1) throw new DOMException("Snapshot invalidated", "NotReadableError");
      };
      try {
        expect(await owner.readRange("revision:0", { offset: 7, length: 9 })).toEqual(
          Uint8Array.from({ length: 9 }, (_, i) => pattern(7 + i)),
        );
        expect(attempts).toBe(2);
        expect(value.file().snapshots).toBe(2);
        expect(value.file().accesses).toHaveLength(0);
      } finally {
        retention.release();
      }
    }));
}

test("retained OPFS invalidation exhaustion rejects and releases read work", () =>
  fixture(async (value) => {
    const { owner, retention } = await retained(value);
    const failure = new DOMException("Still invalid", "NotReadableError");
    value.file().snapshotRead = async () => {
      throw failure;
    };
    try {
      await expect(owner.readRange("revision:0", { offset: 0, length: 1 })).rejects.toBe(failure);
      expect(value.file().snapshots).toBe(3);
      expect(owner.resources().opfsReaderWork).toBe(0);
      await owner.close();
      expect(value.held).toBe(false);
    } finally {
      retention.release();
    }
  }));

for (const reason of [new DOMException("Denied", "SecurityError"), new Error("NotReadableError")]) {
  test(`retained OPFS propagates unrelated ${reason.name} without retry`, () =>
    fixture(async (value) => {
      const { owner, retention } = await retained(value);
      value.file().snapshotRead = async () => {
        throw reason;
      };
      try {
        await expect(owner.readRange("revision:0", { offset: 0, length: 1 })).rejects.toBe(reason);
        expect(value.file().snapshots).toBe(1);
      } finally {
        retention.release();
      }
    }));
}

test("close joins a failing retained read and still releases native ownership", () =>
  fixture(async (value) => {
    const { owner, retention } = await retained(value);
    await owner.read("revision:0");
    const entered = value.gate(),
      finish = value.gate();
    const failure = new Error("Native read failure");
    value.file().snapshotRead = async () => {
      entered.resolve();
      await finish.promise;
      throw failure;
    };
    const read = value.track(owner.readRange("revision:0", { offset: 0, length: 1 }));
    try {
      await entered.promise;
      const closing = owner.close();
      finish.resolve();
      await expect(read).rejects.toBe(failure);
      await closing;
      expect(value.held).toBe(false);
      expect(owner.resources().opfsReaderWork).toBe(0);
      expect(value.file().accesses.every((access) => !access.active && access.closes === 1)).toBe(
        true,
      );
    } finally {
      finish.resolve();
      retention.release();
    }
  }));

test("full OPFS reads validate native size before allocating or reading", () =>
  fixture(async (value) => {
    const owner = await value.open();
    await owner.load();
    value.file().size = Number.MAX_SAFE_INTEGER;
    await expect(owner.read("revision:0")).rejects.toThrow("Invalid filesystem payload size");
    expect(value.file().reads).toHaveLength(0);
  }));

for (const stage of ["snapshotGet", "snapshotRead"] as const) {
  test(`unreadable initial metadata at ${stage} cannot be reseeded as an empty workspace`, () =>
    fixture(async (value) => {
      const workspace = await value.root.getDirectoryHandle(value.root.nodes.keys().next().value!);
      const metadata = await workspace.getDirectoryHandle("metadata");
      const snapshot = await metadata.getFileHandle("snapshot-1.json");
      metadata.nodes.delete("snapshot-1.json");
      metadata.nodes.set("snapshot-initial.json", snapshot);
      const failure = new DOMException("Native I/O fault", "UnknownError");
      snapshot[stage] = async () => {
        throw failure;
      };
      const owner = await value.open();
      await expect(owner.load()).rejects.toBe(failure);
      expect(metadata.nodes.has("snapshot-initial.json")).toBe(true);
      await expect(owner.load()).rejects.toBe(failure);
    }));
}

test("metadata retries invalidation but an unknown newest read fault cannot roll back", () =>
  fixture(async (value) => {
    const workspace = await value.root.getDirectoryHandle(value.root.nodes.keys().next().value!);
    const metadata = await workspace.getDirectoryHandle("metadata");
    const snapshot = await metadata.getFileHandle("snapshot-1.json");
    let attempts = 0;
    snapshot.snapshotRead = async () => {
      if (++attempts === 1) throw new DOMException("Invalidated", "NotReadableError");
    };
    const owner = await value.open();
    expect((await owner.load())?.generation).toBe(1);
    expect(snapshot.snapshots).toBe(2);
    await owner.persist({ generation: 2, root: 1, upserts: [], removes: [], data: new Map() });
    await owner.close();
    const newest = Array.from(metadata.nodes.entries()).find(([name]) =>
      name.startsWith("snapshot-2-"),
    );
    expect(newest).toBeDefined();
    const file = await metadata.getFileHandle(newest![0]);
    const failure = new DOMException("Unreadable newest checkpoint", "UnknownError");
    file.snapshotRead = async () => {
      throw failure;
    };
    const next = await value.open();
    await expect(next.load()).rejects.toBe(failure);
    await expect(
      next.persist({ generation: 3, root: 1, upserts: [], removes: [], data: new Map() }),
    ).rejects.toBe(failure);
  }));

test("retained snapshot abort prevents another acquisition", () =>
  fixture(async (value) => {
    const { owner, retention } = await retained(value);
    const cancelled = new AbortController();
    const entered = value.gate(),
      finish = value.gate();
    value.file().snapshotGet = async () => {
      entered.resolve();
      await finish.promise;
      throw new DOMException("Invalidated", "NotReadableError");
    };
    const options = { offset: 1, length: 2, signal: cancelled.signal };
    const read = value.track(owner.readRange("revision:0", options));
    try {
      await entered.promise;
      cancelled.abort(false);
      finish.resolve();
      await expect(read).rejects.toBe(false);
      expect(value.file().snapshots).toBe(1);
    } finally {
      finish.resolve();
      retention.release();
    }
  }));

test("immutable-key verification uses one bounded scratch buffer and progressing reads", async () => {
  const value = new RangeFixture();
  const size = 256 * 1024 + 3;
  try {
    await value.seed([size]);
    const owner = await value.open();
    const index = await owner.load();
    expect(index).toBeDefined();
    value.file().step = 17_000;
    const data = Uint8Array.from({ length: size }, (_, i) => pattern(i));
    await owner.persist({
      generation: 2,
      root: 1,
      upserts: [],
      removes: [],
      data: new Map([["revision:0", data]]),
    });
    const buffers = new Set(value.file().reads.map((read) => read.buffer));
    expect(Array.from(buffers, (buffer) => buffer.byteLength)).toEqual([64 * 1024]);
    expect(value.file().reads.length).toBeGreaterThan(4);
    data[size - 1] = data[size - 1]! ^ 1;
    await expect(
      owner.persist({
        generation: 3,
        root: 1,
        upserts: [],
        removes: [],
        data: new Map([["revision:0", data]]),
      }),
    ).rejects.toThrow("immutable");
    expect((await owner.load())?.generation).toBe(2);
    expect(value.file().accesses.every((access) => !access.active)).toBe(true);
  } finally {
    await value.cleanup();
  }
});
