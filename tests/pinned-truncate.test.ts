import { expect, test } from "bun:test";
import { PAGE } from "../fs/protocol";
import { residentReadFixture } from "./fixtures/workspace-read";
import { measureTruncatePages } from "./fixtures/truncate-page-work";

for (const { pages, size, copies } of [
  { pages: 256, size: 0, copies: 0 },
  { pages: 255, size: 1, copies: 1 },
  { pages: 128, size: 1, copies: 1 },
  { pages: 256, size: PAGE, copies: 0 },
]) {
  test(`public pinned truncate ${pages} pages to ${size} reserves and copies only ${copies} pages`, async () => {
    const value = await residentReadFixture(pages * PAGE, 256 * PAGE);
    const work = measureTruncatePages(value.backend.shared);
    try {
      const first = await value.workspace.pin("/file");
      if (first.kind !== "ok") throw new Error(first.kind);
      const second = await value.workspace.pin("/file");
      if (second.kind !== "ok") throw new Error(second.kind);
      const id = value.backend.identity(value.handle).id;
      const version = value.backend.identity(value.handle).version;
      const error = await value.client.asyncCall("resize", [value.handle, size, true]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect({ error, ...work.counts }).toEqual({
        error: undefined,
        reserved: copies,
        copied: copies,
      });
      expect(value.backend.shared.stat(value.handle)!.size).toBe(size);
      expect(value.backend.identity(value.handle).id).toEqual(id);
      expect(value.backend.identity(value.handle).version).not.toEqual(version);
      expect(value.backend.shared.publication!.stopped).toBe(false);
      expect(value.backend.shared.resources().usedBytes).toBe((pages + copies) * PAGE);
      const boundary = await first.value.read({ offset: Math.max(0, size - 1), length: 3 });
      expect(boundary.kind).toBe("ok");
      if (boundary.kind === "ok") expect(boundary.value.bytes).toEqual(new Uint8Array(3).fill(65));
      await first.value.close();
      expect(value.backend.shared.resources().usedBytes).toBe((pages + copies) * PAGE);
      const tail = await second.value.read({ offset: pages * PAGE - 3, length: 3 });
      expect(tail.kind).toBe("ok");
      if (tail.kind === "ok") expect(tail.value.bytes).toEqual(new Uint8Array(3).fill(65));
      await second.value.close();
      expect(value.backend.shared.resources().usedBytes).toBe(Math.ceil(size / PAGE) * PAGE);
      work.restore();
      await value.client.asyncCall("resize", [value.handle, pages * PAGE, true]);
      const live = await value.client.asyncCall("read", [value.handle, 3, size]);
      expect(live).toEqual(new Uint8Array(3));
      expect(await value.client.asyncCall("read", [value.handle, 3, pages * PAGE - 3])).toEqual(
        new Uint8Array(3),
      );
    } finally {
      work.restore();
      await value.close();
    }
  });
}

test("required partial-page COW failure preserves identity, publication and old bytes", async () => {
  const value = await residentReadFixture(256 * PAGE, 256 * PAGE);
  const work = measureTruncatePages(value.backend.shared);
  try {
    const pin = await value.workspace.pin("/file");
    if (pin.kind !== "ok") throw new Error(pin.kind);
    const stat = value.backend.shared.stat(value.handle);
    const identity = value.backend.identity(value.handle);
    const cut = value.backend.shared.publication!.cut();
    const error = await value.client.asyncCall("resize", [value.handle, 1, true]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ errno: 6 });
    expect(work.counts).toEqual({ reserved: 0, copied: 0 });
    expect(value.backend.shared.stat(value.handle)).toEqual(stat);
    expect(value.backend.identity(value.handle)).toEqual(identity);
    expect(value.backend.shared.publication!.cut()).toEqual(cut);
    expect(value.backend.shared.publication!.stopped).toBe(false);
    expect(value.backend.shared.resources().usedBytes).toBe(256 * PAGE);
    const read = await pin.value.read({ offset: 0, length: 3 });
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.value.bytes).toEqual(new Uint8Array(3).fill(65));
    await pin.value.close();
    await value.client.asyncCall("resize", [value.handle, 1, true]);
    expect(value.backend.shared.stat(value.handle)!.size).toBe(1);
  } finally {
    work.restore();
    await value.close();
  }
});
