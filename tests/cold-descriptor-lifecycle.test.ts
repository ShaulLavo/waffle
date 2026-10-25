import { expect, test } from "bun:test";
import { coldDescriptorFixture, coldByte } from "./fixtures/cold-descriptor";

async function ready(fixture: Awaited<ReturnType<typeof coldDescriptorFixture>>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fixture.client.ioReadiness(fixture.handle, false).readable) return;
    await Bun.sleep(1);
  }
  throw new Error("range did not become ready");
}

test("write readiness must preserve a completed cold read", async () => {
  const fixture = await coldDescriptorFixture();
  try {
    const bytes = new Uint8Array(1).fill(201);
    expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-6);
    await ready(fixture);
    expect(fixture.counters.ranges).toEqual([{ offset: 123, length: 1 }]);
    expect(fixture.client.ioReadiness(fixture.handle, false).readable).toBe(true);
    expect(fixture.client.ioReadiness(fixture.handle, true).writable).toBe(false);
    const retry = fixture.client.tryRead(fixture.handle, [bytes], 123);
    expect(retry).toBe(1);
    expect(bytes[0]).toBe(coldByte(123));
    expect(fixture.counters.wholeBytes).toBe(0);
    expect(fixture.counters.ranges).toEqual([{ offset: 123, length: 1 }]);
    expect(fixture.client.completions.size).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("cancelled service range must not prevent backend storage close", async () => {
  const fixture = await coldDescriptorFixture();
  const gate = fixture.pauseRange();
  let storageCloses = 0;
  fixture.storage.close = async () => {
    storageCloses++;
  };
  try {
    expect(fixture.client.tryRead(fixture.handle, [new Uint8Array(1)], 123)).toBe(-6);
    await gate.entered;
    const closing = fixture.backend.close().then(
      () => "closed",
      (error) => `errno:${error.errno}`,
    );
    fixture.client.release(fixture.handle);
    gate.release();
    const outcome = await closing;
    expect(fixture.counters.retained).toBe(0);
    expect(outcome).toBe("closed");
    expect(storageCloses).toBe(1);
  } finally {
    gate.release();
    await fixture.close().catch(() => {});
    fixture.client.connection.port.close();
    fixture.service.dispose();
  }
});

for (const failure of [false, true]) {
  test(`mixed polling preserves a pending cold read, storage failure=${failure}`, async () => {
    const fixture = await coldDescriptorFixture();
    if (failure)
      fixture.storage.readRange = async () => {
        throw new Error("range failed");
      };
    const gate = fixture.pauseRange();
    try {
      const bytes = new Uint8Array(1).fill(201);
      expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(-6);
      await gate.entered;
      expect(fixture.client.ioReadiness(fixture.handle, true).writable).toBe(false);
      expect(fixture.client.ioReadiness(fixture.handle, false).readable).toBe(false);
      gate.release();
      await ready(fixture);
      expect(fixture.client.ioReadiness(fixture.handle, true).writable).toBe(false);
      expect(fixture.client.ioReadiness(fixture.handle, false).readable).toBe(true);
      expect(fixture.client.tryRead(fixture.handle, [bytes], 123)).toBe(failure ? -29 : 1);
      expect(bytes[0]).toBe(failure ? 201 : coldByte(123));
      expect(fixture.counters.wholeBytes).toBe(0);
      expect(fixture.counters.rangeBytes).toBe(failure ? 0 : 1);
      expect(fixture.counters.retained).toBe(0);
      expect(fixture.client.completions.size).toBe(0);
    } finally {
      gate.release();
      await fixture.close();
    }
  });
}

for (const cancel of [false, true]) {
  test(`close drains a failed descriptor read without losing its errno, cancellation=${cancel}`, async () => {
    const fixture = await coldDescriptorFixture();
    if (!cancel)
      fixture.storage.readRange = async () => {
        throw new Error("range failed");
      };
    const gate = fixture.pauseRange();
    let cancelled = false;
    let storageCloses = 0;
    fixture.storage.close = async () => {
      storageCloses++;
    };
    try {
      const read = fixture.backend.prepareDescriptorRead(fixture.handle, 123, 1, () => cancelled)!;
      const result = read.then(
        () => 0,
        (error) => error.errno,
      );
      await gate.entered;
      const closing = fixture.backend.close();
      const closed = closing.then(
        () => "closed",
        () => "failed",
      );
      cancelled = cancel;
      gate.release();
      expect(await result).toBe(cancel ? 11 : 29);
      expect(await closed).toBe("closed");
      expect(fixture.backend.close()).toBe(closing);
      expect(storageCloses).toBe(1);
      expect(fixture.counters.retained).toBe(0);
    } finally {
      gate.release();
      await fixture.close().catch(() => {});
      fixture.client.connection.port.close();
      fixture.service.dispose();
    }
  });
}
