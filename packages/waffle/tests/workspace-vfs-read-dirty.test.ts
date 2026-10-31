import { expect, test } from "bun:test";
import { CheckpointPressure } from "../fs/checkpoint-pressure";
import { PAGE } from "../fs/protocol";
import { residentReadFixture, publicReadFixture } from "./fixtures/workspace-read";
import { PersistentBackend } from "../fs/persistent";
import { RangeFixture } from "./fixtures/opfs-range-storage";

function constrain(value: Awaited<ReturnType<typeof residentReadFixture>>, pages: number) {
  value.backend.shared.dirtyAdmission.configure(
    { maxBytes: PAGE * pages + value.backend.shared.stat(value.handle)!.size * 4 + 64 },
    new CheckpointPressure().limits,
    0,
  );
}

test("dirty rejection of a retained multi-iovec write leaves no COW allocation or effect", async () => {
  const value = await residentReadFixture(PAGE * 2);
  try {
    const old = value.pin();
    constrain(value, 2);
    const before = value.backend.shared.snapshot(value.handle);
    const identity = value.backend.identity(value.handle);
    const cut = value.backend.shared.publication!.cut();
    expect(
      value.client.tryWrite(value.handle, [new Uint8Array([90]), new Uint8Array([91])], PAGE - 1),
    ).toBe(-6);
    expect(value.backend.shared.resources().usedBytes).toBe(PAGE * 2);
    expect(value.backend.shared.snapshot(value.handle)).toEqual(before);
    expect(value.backend.identity(value.handle)).toEqual(identity);
    expect(value.backend.shared.publication!.cut()).toEqual(cut);
    expect(old.read(PAGE - 1, 2)).toEqual(new Uint8Array([65, 65]));
    constrain(value, 4);
    expect(
      value.client.tryWrite(value.handle, [new Uint8Array([90]), new Uint8Array([91])], PAGE - 1),
    ).toBe(2);
    expect(value.backend.shared.resources().usedBytes).toBe(PAGE * 4);
    expect(old.read(PAGE - 1, 2)).toEqual(new Uint8Array([65, 65]));
  } finally {
    await value.close();
  }
});

test("persistent service dirty refusal rolls back complete retained writeFile reservations", async () => {
  const physical = new RangeFixture();
  let value: ReturnType<typeof publicReadFixture> | undefined;
  try {
    await physical.seed([PAGE * 2]);
    const backend = await PersistentBackend.open(await physical.open(), {
      intervalMs: 0,
      dirtyLimits: { maxBytes: PAGE * 10 + 64 },
    });
    value = publicReadFixture(backend);
    const root = await value.client.asyncCall("preopen", ["/"]);
    const handle = (await value.client.asyncCall("resolve", [root, "file"])).node;
    await backend.prepare("read", [handle]);
    const old = await value.workspace.pin("/file");
    if (old.kind !== "ok") throw new Error(old.kind);
    const before = backend.shared.snapshot(handle);
    const identity = backend.identity(handle);
    await expect(
      value.client.asyncCall("writeFile", ["/file"], new Uint8Array(PAGE * 3)),
    ).rejects.toMatchObject({ errno: 6 });
    expect(backend.shared.resources().usedBytes).toBe(PAGE * 2);
    expect(backend.shared.snapshot(handle)).toEqual(before);
    expect(backend.identity(handle)).toEqual(identity);
    const distant = await old.value.read({ offset: PAGE, length: 1 });
    expect(distant.kind).toBe("ok");
    if (distant.kind === "ok")
      expect(distant.value.bytes).toEqual(before!.data.slice(PAGE, PAGE + 1));
    await old.value.close();
  } finally {
    await value?.close();
    await physical.cleanup();
  }
});

test("retired pages keep their physical charge until the final reader releases", async () => {
  const value = await residentReadFixture(PAGE * 2);
  try {
    const old = value.pin();
    await value.client.asyncCall("resize", [value.handle, 1, true]);
    expect(value.backend.shared.resources().usedBytes).toBe(PAGE * 3);
    expect(old.read(PAGE, 1)).toEqual(new Uint8Array([65]));
    constrain(value, 3);
    const change = value.backend.shared.dirtyAdmission.change;
    old.release();
    expect(value.backend.shared.resources().usedBytes).toBe(PAGE);
    expect(value.backend.shared.dirtyAdmission.change).toBeGreaterThan(change);
  } finally {
    await value.close();
  }
});

test("retained truncate pressure rejects before charging dirty debt or changing identity", async () => {
  const value = await residentReadFixture(PAGE * 2);
  try {
    value.pin();
    value.backend.shared.dirtyAdmission.configure(
      { maxBytes: PAGE * 2 + 64 },
      new CheckpointPressure().limits,
      0,
    );
    const before = value.backend.shared.snapshot(value.handle);
    const identity = value.backend.identity(value.handle);
    expect(() =>
      value.backend.execute("resize", [value.handle, 1, true], new Uint8Array()),
    ).toThrow("dirty capacity");
    expect(value.backend.shared.snapshot(value.handle)).toEqual(before);
    expect(value.backend.identity(value.handle)).toEqual(identity);
    expect(value.backend.shared.resources().usedBytes).toBe(PAGE * 2);
    expect(value.backend.shared.dirtyAdmission.hasDebt).toBe(false);
  } finally {
    await value.close();
  }
});
