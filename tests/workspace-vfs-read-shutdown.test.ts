import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import { PAGE } from "../fs/protocol";
import { RangeFixture } from "./fixtures/opfs-range-storage";
import { publicReadFixture } from "./fixtures/workspace-read";

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const outcome = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ kind: "ok" as const, value }),
    (reason: unknown) => ({ kind: "failed" as const, reason }),
  );

test("public shutdown joins the original reader before the actual backend close", async () => {
  const physical = new RangeFixture();
  const gate = physical.gate();
  const entered = Promise.withResolvers<void>();
  let value: ReturnType<typeof publicReadFixture> | undefined;
  let reading: Promise<unknown> | undefined;
  let closing: Promise<unknown> | undefined;
  try {
    await physical.seed([PAGE * 3]);
    const storage = await physical.open();
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    value = publicReadFixture(backend);
    let closes = 0;
    const close = backend.close.bind(backend);
    backend.close = () => {
      closes++;
      return close();
    };
    physical.file().snapshotRead = async () => {
      entered.resolve();
      await gate.promise;
    };
    reading = value.workspace.read("/file", { offset: PAGE, length: 4096 });
    await entered.promise;
    const original = value.service.shutdown();
    expect(value.service.shutdown()).toBe(original);
    let settled = false;
    closing = outcome(original).then((result) => {
      settled = true;
      return result;
    });
    await turn();
    expect(settled).toBe(false);
    expect(closes).toBe(0);
    expect(storage.resources().opfsReaderWork).toBe(1);
    gate.resolve();
    expect(await closing).toEqual({ kind: "ok", value: undefined });
    expect(await reading).toEqual({ kind: "stopped" });
    expect(closes).toBe(1);
    expect(storage.resources().opfsReaderWork).toBe(0);
    expect(storage.resources().readerStorageBytes).toBe(0);
    expect(value.service.resources().readerLeases).toBe(0);
    expect(value.service.shutdown()).toBe(original);
  } finally {
    gate.resolve();
    await Promise.allSettled([reading, closing]);
    await value?.close();
    await physical.cleanup();
  }
});

for (const reason of [undefined, null, false, 0, new Error("reader release failed")]) {
  test(`public shutdown retains the original failed reader owner: ${String(reason)}`, async () => {
    const physical = new RangeFixture();
    let value: ReturnType<typeof publicReadFixture> | undefined;
    const releases: (() => void)[] = [];
    try {
      await physical.seed([PAGE * 3]);
      const storage = await physical.open();
      const retain = storage.retainPayload.bind(storage);
      storage.retainPayload = (...args) => {
        const token = retain(...args);
        releases.push(() => token.release());
        return {
          release() {
            throw reason;
          },
        };
      };
      const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
      value = publicReadFixture(backend);
      let closes = 0;
      const close = backend.close.bind(backend);
      backend.close = () => {
        closes++;
        return close();
      };
      expect((await value.workspace.pin("/file")).kind).toBe("ok");
      const original = value.service.shutdown();
      const result = await outcome(original);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(Object.is(result.reason, reason)).toBe(true);
      expect(closes).toBe(0);
      expect(storage.resources().readerStorageBytes).toBe(PAGE * 3);
      expect(value.service.resources().readerLeases).toBe(1);
      expect(value.service.shutdown()).toBe(original);
      expect(await outcome(value.service.shutdown())).toEqual(result);
    } finally {
      for (const release of releases) release();
      await Promise.allSettled([value?.close()]);
      await physical.cleanup();
    }
  });
}
