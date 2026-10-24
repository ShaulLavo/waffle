import { expect, test } from "bun:test";
import { PersistentBackend } from "../fs";
import { PAGE } from "../fs/protocol";
import { RangeFixture, payloadSize } from "./fixtures/opfs-range-storage";
import { publicReadFixture } from "./fixtures/workspace-read";

const offset = PAGE - 3;
const byteAt = (at: number) => (at * 17 + 3 + Math.floor(at / PAGE) * 29) & 255;

for (const length of [PAGE, 1024 * 1024]) {
  test(`first cold leased ${length}-byte range survives replacement with exact ordered bytes`, async () => {
    const physical = new RangeFixture();
    const gate = physical.gate();
    const entered = Promise.withResolvers<void>();
    let view: ReturnType<typeof publicReadFixture> | undefined;
    let reading: Promise<unknown> | undefined;
    try {
      await physical.seed();
      physical.file().data = Uint8Array.from({ length: offset + length }, (_, at) => byteAt(at));
      const storage = await physical.open();
      const readRange = storage.readRange.bind(storage);
      let calls = 0;
      let first: Uint8Array | undefined;
      storage.read = async () => {
        throw new Error("cold proof must not call whole-payload read");
      };
      storage.readRange = async (key, options) => {
        const bytes = await readRange(key, options);
        calls++;
        if (process.env.PROOF_DUPLICATE_CHUNK === "1" && calls === 2 && first) return first.slice();
        first ??= bytes;
        return bytes;
      };
      const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
      view = publicReadFixture(backend);
      const initialUsed = backend.shared.resources().usedBytes;
      expect(physical.file().reads).toHaveLength(0);
      expect(backend.shared.registeredHandles()).toHaveLength(0);
      const pinned = await view.workspace.pin("/file");
      if (pinned.kind !== "ok") throw new Error(pinned.kind);
      expect(pinned.value.stat.size).toBe(payloadSize);
      expect(physical.file().reads).toHaveLength(0);
      expect(backend.shared.resources().usedBytes).toBe(initialUsed);
      expect(backend.shared.registeredHandles()).toHaveLength(0);
      const accessCount = physical.file().accesses.length;
      physical.file().snapshotRead = async () => {
        entered.resolve();
        await gate.promise;
      };
      const result = pinned.value.read({ offset, length });
      reading = result;
      await entered.promise;
      await view.client.asyncCall("remove", ["/file"]);
      await view.client.asyncCall("writeFile", ["/file"], new Uint8Array([91]));
      const current = await view.workspace.read("/file");
      if (current.kind !== "ok") throw new Error(current.kind);
      expect(current.value.bytes).toEqual(new Uint8Array([91]));
      expect(current.value.stat.id).not.toBe(pinned.value.stat.id);
      expect(current.value.stat.cut).not.toEqual(pinned.value.stat.cut);
      const usedAfterWriter = backend.shared.resources().usedBytes;
      const registeredAfterWriter = backend.shared.registeredHandles();
      gate.resolve();
      const read = await result;
      if (read.kind !== "ok") throw new Error(read.kind);
      expect(read.value.stat).toEqual(pinned.value.stat);
      expect(read.value.range).toEqual({ offset, length });
      const mismatch = read.value.bytes.findIndex((byte, index) => byte !== byteAt(offset + index));
      expect(mismatch, "every chunk must contain its own selected-version bytes").toBe(-1);
      expect(read.value.bytes).toHaveLength(length);
      expect(physical.file().reads.map(({ at, length }) => ({ at, length }))).toEqual(
        Array.from({ length: length / PAGE }, (_, index) => ({
          at: offset + index * PAGE,
          length: PAGE,
        })),
      );
      expect(physical.file().reads.every(({ buffer }) => buffer.byteLength === PAGE)).toBe(true);
      expect(physical.file().accesses).toHaveLength(accessCount);
      expect(backend.shared.resources().usedBytes).toBe(usedAfterWriter);
      expect(backend.shared.registeredHandles()).toEqual(registeredAfterWriter);
      expect(view.service.resources()).toMatchObject({
        readerOperations: 0,
        readerTickets: 0,
        readerResultBytes: 0,
      });
      await pinned.value.close();
      expect(view.service.resources()).toMatchObject({ readerLeases: 0, readerPinBytes: 0 });
      expect(storage.resources().readerStorageBytes).toBe(0);
      expect(view.client.completions.size).toBe(0);
      console.log(
        JSON.stringify({
          length,
          logicalSize: payloadSize,
          fixtureBytes: offset + length,
          physicalCalls: physical.file().reads.length,
          physicalBytes: physical.file().reads.reduce((sum, read) => sum + read.length, 0),
          mismatch,
        }),
      );
    } finally {
      gate.resolve();
      await reading;
      try {
        await view?.close();
      } finally {
        await physical.cleanup();
      }
    }
  });
}
