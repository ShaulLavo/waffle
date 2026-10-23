import { expect, test } from "bun:test";
import { PAGE } from "../fs/protocol";
import { residentReadFixture } from "./fixtures/workspace-read";

async function deniedWrite(value: Awaited<ReturnType<typeof residentReadFixture>>) {
  const lease = await value.service.pauseFilesystemWrites();
  try {
    await expect(
      value.client.asyncCall("writeFile", ["/file"], new Uint8Array([90])),
    ).rejects.toMatchObject({ errno: 6 });
  } finally {
    await lease.release();
  }
}

test("public range reads and reader release remain live during a writer cut", async () => {
  const value = await residentReadFixture(PAGE * 2);
  let lease: Awaited<ReturnType<typeof value.service.pauseFilesystemWrites>> | undefined;
  try {
    lease = await value.service.pauseFilesystemWrites();
    expect(await value.client.asyncCall("preopen", ["/"])).toBe(value.directory);
    const pinned = await value.workspace.pin("/file");
    if (pinned.kind !== "ok") throw new Error(pinned.kind);
    try {
      const read = await pinned.value.read({ offset: PAGE, length: 1 });
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") expect(read.value.bytes).toEqual(new Uint8Array([65]));
      expect(value.client.tryWrite(value.handle, [new Uint8Array([90])], PAGE)).toBe(-6);
      expect(value.backend.shared.writeAdmission.active).toBe(0);
    } finally {
      await pinned.value.close();
    }
    expect(value.backend.shared.readerPinBytes()).toBe(0);
    await lease.flush();
  } finally {
    await lease?.release();
    await value.close();
  }
});

test("a retained public version keeps COW charges across pause, write and truncate", async () => {
  const value = await residentReadFixture(PAGE * 2);
  try {
    const pinned = await value.workspace.pin("/file");
    if (pinned.kind !== "ok") throw new Error(pinned.kind);
    try {
      await deniedWrite(value);
      expect(value.client.tryWrite(value.handle, [new Uint8Array([90])], 0)).toBe(1);
      await value.client.asyncCall("resize", [value.handle, 1, true]);
      const old = await pinned.value.read({ offset: PAGE, length: 1 });
      expect(old.kind).toBe("ok");
      if (old.kind === "ok") expect(old.value.bytes).toEqual(new Uint8Array([65]));
      expect(await value.client.asyncCall("readFile", ["/file"])).toEqual(new Uint8Array([90]));
      expect(value.backend.shared.resources().usedBytes).toBe(PAGE * 3);
      expect(value.backend.shared.writeAdmission.active).toBe(0);
    } finally {
      await pinned.value.close();
    }
    expect(value.backend.shared.resources().usedBytes).toBe(PAGE);
    expect(value.backend.shared.readerPinBytes()).toBe(0);
  } finally {
    await value.close();
  }
});
