import { expect, test } from "bun:test";
import { PAGE } from "../fs/protocol";
import type { ColdReadCache } from "../fs/cold-read-cache";
import { coldByte, coldDescriptorFixture, coldSize } from "./fixtures/cold-descriptor";
import { SLOT_WORDS } from "../fs/shared";

for (const reads of [
  [{ offset: 123, length: 1 }],
  [{ offset: PAGE - 2, length: PAGE + 17 }],
  [
    { offset: coldSize, length: 1 },
    { offset: 123, length: 0 },
  ],
  [
    { offset: 123, length: 1 },
    { offset: 123, length: 1 },
    { offset: PAGE - 2, length: 5 },
  ],
]) {
  test(`instantiated Wasm cold descriptor reads ${JSON.stringify(reads)} without whole hydration`, async () => {
    const fixture = await coldDescriptorFixture();
    try {
      const before = fixture.backend.shared.resources().usedBytes;
      const outcome = await fixture.run(reads);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.results.map(({ error }) => error)).toEqual(reads.map(() => 0));
      const expected = reads.map(({ offset, length }) => Math.min(PAGE, length, coldSize - offset));
      expect(outcome.results.map(({ count }) => count)).toEqual(expected);
      expect(outcome.results.map(({ bytes }, index) => bytes.slice(0, expected[index]))).toEqual(
        reads.map(({ offset }, index) =>
          Array.from({ length: expected[index]! }, (_, at) => coldByte(offset + at)),
        ),
      );
      expect(fixture.counters.wholeBytes).toBe(0);
      expect(fixture.counters.rangeBytes).toBe(expected.reduce((sum, count) => sum + count, 0));
      expect(fixture.backend.shared.resources().usedBytes).toBe(before);
      expect(fixture.counters.retained).toBe(0);
    } finally {
      await fixture.close();
    }
  });
}

async function readable(
  client: Awaited<ReturnType<typeof coldDescriptorFixture>>["client"],
  handle: number,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (client.ioReadiness(handle, false).readable) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("cold range did not become readable");
}

test("nonblocking cold range is consumed by the retry, not readiness", async () => {
  const fixture = await coldDescriptorFixture();
  try {
    const bytes = new Uint8Array(5).fill(201);
    expect(fixture.client.tryRead(fixture.handle, [bytes], PAGE - 2)).toBe(-6);
    expect(bytes).toEqual(new Uint8Array(5).fill(201));
    await readable(fixture.client, fixture.handle);
    expect(fixture.client.ioReadiness(fixture.handle, false).readable).toBe(true);
    expect(fixture.client.tryRead(fixture.handle, [bytes], PAGE - 2)).toBe(5);
    expect(bytes).toEqual(Uint8Array.from({ length: 5 }, (_, at) => coldByte(PAGE - 2 + at)));
    expect(fixture.counters.wholeBytes).toBe(0);
    expect(fixture.counters.rangeBytes).toBe(5);
    expect(fixture.client.completions.size).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a changed retry offset selects another bounded range", async () => {
  const fixture = await coldDescriptorFixture();
  try {
    const bytes = new Uint8Array(1).fill(201);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-6);
    await readable(fixture.client, fixture.handle);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 456)).toBe(-6);
    expect(bytes[0]).toBe(201);
    await readable(fixture.client, fixture.handle);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 456)).toBe(1);
    expect(bytes[0]).toBe(coldByte(456));
    expect(fixture.counters.ranges).toEqual([
      { offset: 123, length: 1 },
      { offset: 456, length: 1 },
    ]);
  } finally {
    await fixture.close();
  }
});

test("a newer live revision replaces a completed cold range before retry", async () => {
  const fixture = await coldDescriptorFixture();
  try {
    const bytes = new Uint8Array(1);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 0)).toBe(-6);
    await readable(fixture.client, fixture.handle);
    await fixture.client.asyncCall("resize", [fixture.handle, 0, true]);
    await fixture.client.asyncCall("write", [fixture.handle, 0], new Uint8Array([91]));
    expect(fixture.client.tryRead(fixture.handle, [bytes], 0)).toBe(1);
    expect(bytes[0]).toBe(91);
    expect(fixture.client.completions.size).toBe(0);
    expect(fixture.counters.wholeBytes).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("cold range failure reaches retry and releases its retained payload", async () => {
  const fixture = await coldDescriptorFixture();
  fixture.storage.readRange = async () => {
    throw new Error("storage unavailable");
  };
  try {
    expect(fixture.client.tryRead(fixture.handle, [new Uint8Array(1)], 123)).toBe(-6);
    await readable(fixture.client, fixture.handle);
    expect(fixture.client.tryRead(fixture.handle, [new Uint8Array(1)], 123)).toBe(-29);
    expect(fixture.counters.retained).toBe(0);
    expect(fixture.client.completions.size).toBe(0);
  } finally {
    await fixture.close();
  }
});

for (const args of [
  [-1, 1],
  [0, -1],
  [Number.MAX_SAFE_INTEGER + 1, 1],
]) {
  test(`invalid cold range ${args} does not retain or read payload`, async () => {
    const fixture = await coldDescriptorFixture();
    try {
      const error = await fixture.client.asyncCall("read", [fixture.handle, args[1], args[0]]).then(
        () => 0,
        (error) => error.errno,
      );
      expect(error).toBe(28);
      expect(fixture.counters.rangeBytes).toBe(0);
      expect(fixture.counters.wholeBytes).toBe(0);
      expect(fixture.counters.retained).toBe(0);
    } finally {
      await fixture.close();
    }
  });
}

test("inflight exported descriptor range retains the unlinked inode through replacement and checkpoint", async () => {
  const fixture = await coldDescriptorFixture();
  const gate = fixture.pauseRange();
  try {
    const read = fixture.run([{ offset: 123, length: 1 }]);
    await gate.entered;
    expect(fixture.counters.retained).toBe(1);
    await fixture.client.asyncCall("remove", ["/file"]);
    await fixture.client.asyncCall("writeFile", ["/file"], new Uint8Array([91]));
    await fixture.backend.checkpoint();
    gate.release();
    expect((await read).results).toEqual([{ error: 0, count: 1, bytes: [coldByte(123)] }]);
    expect(fixture.counters.retained).toBe(0);
  } finally {
    gate.release();
    await fixture.close();
  }
});

test("cancelling an inflight range drains retained storage without touching caller bytes", async () => {
  const fixture = await coldDescriptorFixture();
  const gate = fixture.pauseRange();
  try {
    const bytes = new Uint8Array(1).fill(201);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-6);
    await gate.entered;
    fixture.client.release(fixture.handle);
    expect(fixture.client.completions.size).toBe(0);
    gate.release();
    await fixture.service.drainForOwner();
    expect(bytes[0]).toBe(201);
    expect(fixture.counters.retained).toBe(0);
    expect(fixture.counters.wholeBytes).toBe(0);
  } finally {
    gate.release();
    await fixture.close();
  }
});

test("completed cold range retry does not spin on a held revision file lock", async () => {
  const fixture = await coldDescriptorFixture();
  const lock = fixture.client.shared.fileSlot(fixture.handle) * SLOT_WORDS + 8;
  try {
    const bytes = new Uint8Array(1).fill(201);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-6);
    await readable(fixture.client, fixture.handle);
    fixture.client.shared.onContention = () => {
      throw new Error("spinning on revision lock");
    };
    Atomics.store(fixture.client.shared.slots, lock, 123);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-6);
    expect(bytes[0]).toBe(201);
    Atomics.store(fixture.client.shared.slots, lock, 0);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(1);
    expect(bytes[0]).toBe(coldByte(123));
  } finally {
    Atomics.store(fixture.client.shared.slots, lock, 0);
    await fixture.close();
  }
});

test("short retained range fails without touching the retry buffer", async () => {
  const fixture = await coldDescriptorFixture();
  fixture.storage.readRange = async () => new Uint8Array();
  try {
    const bytes = new Uint8Array(1).fill(201);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-6);
    await readable(fixture.client, fixture.handle);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-29);
    expect(bytes[0]).toBe(201);
    expect(fixture.counters.retained).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("backend close waits until its bounded retained range is released", async () => {
  const fixture = await coldDescriptorFixture();
  const gate = fixture.pauseRange();
  try {
    const read = fixture.client.asyncCall("read", [fixture.handle, 1, 123]);
    await gate.entered;
    let closed = false;
    const closing = fixture.backend.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(fixture.counters.retained).toBe(1);
    gate.release();
    expect(await read).toEqual(new Uint8Array([coldByte(123)]));
    await closing;
    expect(fixture.counters.retained).toBe(0);
    expect(closed).toBe(true);
  } finally {
    gate.release();
    await fixture.close();
  }
});

const pageBytes = (index: number, length = PAGE) =>
  Uint8Array.from({ length }, (_, at) => coldByte(index * PAGE + at));

test("rereading an unmodified cold file serves its verified pages without storage", async () => {
  const fixture = await coldDescriptorFixture();
  try {
    const before = fixture.backend.shared.resources().usedBytes;
    for (let pass = 0; pass < 3; pass++)
      for (let index = 0; index < 4; index++)
        expect(
          await fixture.client.asyncCall("read", [fixture.handle, PAGE, index * PAGE]),
        ).toEqual(pageBytes(index));
    // A range inside or across cached pages is copied from them too.
    expect(await fixture.client.asyncCall("read", [fixture.handle, 5, PAGE - 2])).toEqual(
      Uint8Array.from({ length: 5 }, (_, at) => coldByte(PAGE - 2 + at)),
    );
    expect(fixture.counters.ranges).toEqual(
      [0, 1, 2, 3].map((index) => ({ offset: index * PAGE, length: PAGE })),
    );
    expect(fixture.counters.wholeBytes).toBe(0);
    expect(fixture.counters.retained).toBe(0);
    // Every hit (two later passes of four pages, then the cross-page range) asked storage.
    expect(fixture.counters.checks).toBe(9);
    expect(fixture.backend.shared.resources().usedBytes).toBe(before);
  } finally {
    await fixture.close();
  }
});

test("a cached page is refused once its storage can no longer serve the payload", async () => {
  const fixture = await coldDescriptorFixture();
  try {
    expect(await fixture.client.asyncCall("read", [fixture.handle, PAGE, 0])).toEqual(pageBytes(0));
    // As IndexedDB storage reports after another tab took the workspace over.
    fixture.storage.checkPayload = () => {
      throw new Error("This workspace was opened in another tab. Reload to continue here.");
    };
    const outcome = await fixture.client.asyncCall("read", [fixture.handle, PAGE, 0]).then(
      () => "served",
      () => "refused",
    );
    expect(outcome).toBe("refused");
    expect(fixture.counters.ranges).toHaveLength(1);
    expect(fixture.counters.retained).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a failed close still frees the cached pages", async () => {
  const fixture = await coldDescriptorFixture();
  const cache = (fixture.backend as unknown as { coldReads: ColdReadCache }).coldReads;
  try {
    expect(await fixture.client.asyncCall("read", [fixture.handle, PAGE, 0])).toEqual(pageBytes(0));
    expect(cache.read("cold", 0, PAGE)).toEqual(pageBytes(0));
    // The final checkpoint has a namespace change to persist, and persisting it fails.
    await fixture.client.asyncCall("mkdirp", ["/dirty"]);
    fixture.storage.persist = async () => {
      throw new Error("final checkpoint failed");
    };
    const closed = await fixture.backend.close().then(
      () => "closed",
      (error) => String(error),
    );
    expect(closed).toContain("final checkpoint failed");
    expect(cache.read("cold", 0, 1)).toBeUndefined();
  } finally {
    await fixture.close().catch(() => {});
    fixture.client.connection.port.close();
  }
});

test("a rewritten cold file never serves pages cached for its stored payload", async () => {
  const fixture = await coldDescriptorFixture();
  try {
    expect(await fixture.client.asyncCall("read", [fixture.handle, PAGE, 0])).toEqual(pageBytes(0));
    // The 32 MiB payload cannot hydrate into this 16 MiB pool, so replace it instead.
    await fixture.client.asyncCall("resize", [fixture.handle, 0, true]);
    await fixture.client.asyncCall("write", [fixture.handle, 0], new Uint8Array(PAGE).fill(91));
    expect(await fixture.client.asyncCall("read", [fixture.handle, PAGE, 0])).toEqual(
      new Uint8Array(PAGE).fill(91),
    );
    expect(fixture.counters.ranges).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
