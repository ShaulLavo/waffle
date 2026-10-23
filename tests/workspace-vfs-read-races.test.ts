import { expect, test } from "bun:test";
import { MemoryBackend, PersistentBackend } from "../fs";
import { MemFS } from "../fs/memory";
import { PAGE } from "../fs/protocol";
import { ResidentGrantCell, type ResidentDescriptor } from "../fs/publication-grant";
import { RangeFixture } from "./fixtures/opfs-range-storage";
import { publicReadFixture, residentReadFixture } from "./fixtures/workspace-read";

async function coldFixture(size: number) {
  const physical = new RangeFixture();
  let value: ReturnType<typeof publicReadFixture> | undefined;
  const close = async () => {
    for (const gate of physical.gates) gate.resolve();
    await value?.close();
    await physical.cleanup();
  };
  try {
    await physical.seed([size]);
    const storage = await physical.open();
    value = publicReadFixture(await PersistentBackend.open(storage, { intervalMs: 0 }));
    return { ...value, storage, physical, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test("result reservations refuse a second large read independently of operation slots", async () => {
  const value = await coldFixture(1024 * 1024);
  const entered = Promise.withResolvers<void>(), gate = value.physical.gate();
  let first: Promise<unknown> | undefined;
  try {
    value.physical.file().snapshotRead = async () => { entered.resolve(); await gate.promise; };
    first = value.workspace.read("/file");
    await entered.promise;
    expect(await value.workspace.read("/file")).toEqual({ kind: "pressure", resource: "result-bytes" });
    expect(value.service.resources().readerOperations).toBe(1);
    expect(value.service.resources().readerResultBytes).toBe(8 * 1024 * 1024 + 12 * PAGE + 8192);
    gate.resolve();
    expect(await first).toMatchObject({ kind: "ok" });
    expect(value.service.resources().readerResultBytes).toBe(0);
    expect(value.service.resources().readerResultPeak).toBeLessThanOrEqual(16 * 1024 * 1024);
  } finally {
    gate.resolve();
    await first;
    await value.close();
  }
});

test("cold full-lease metadata refuses before lease slots and charges one physical key", async () => {
  const value = await coldFixture(512 * 1024 * 1024);
  const leases = [];
  try {
    for (let index = 0; index < 3; index++) {
      const opened = await value.workspace.pin("/file");
      expect(opened.kind).toBe("ok");
      if (opened.kind === "ok") leases.push(opened.value);
    }
    expect(await value.workspace.pin("/file")).toEqual({ kind: "pressure", resource: "metadata" });
    expect(value.service.resources().readerLeases).toBe(3);
    expect(value.storage.resources().readerStorageBytes).toBe(512 * 1024 * 1024);
    expect(value.physical.file().reads).toHaveLength(0);
    const peak = value.service.resources().readerMetadataPeak;
    await Promise.all(leases.map((lease) => lease.close()));
    expect(value.service.resources().readerLeases).toBe(0);
    expect(value.service.resources().readerMetadataBytes).toBe(65536 + 1280);
    expect(value.storage.resources().readerStorageBytes).toBe(0);
    expect(peak).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally { await value.close(); }
});

test("retained storage refuses a complete key larger than its budget without native I/O", async () => {
  const value = await coldFixture(512 * 1024 * 1024 + 1);
  try {
    expect(await value.workspace.pin("/file")).toEqual({ kind: "pressure", resource: "retained-storage" });
    expect(value.storage.resources().readerStorageBytes).toBe(0);
    expect(value.service.resources().readerLeases).toBe(0);
    expect(value.physical.file().reads).toHaveLength(0);
  } finally { await value.close(); }
});

test("unique seed buffers share alias charges and independently exhaust pin capacity", async () => {
  const fs = new MemFS();
  for (const path of ["/one", "/two", "/three"]) fs.writeFile(path, new Uint8Array(96 * 1024 * 1024));
  const value = publicReadFixture(new MemoryBackend(fs));
  try {
    const one = await value.workspace.pin("/one"), alias = await value.workspace.pin("/one"), two = await value.workspace.pin("/two");
    if (one.kind !== "ok" || alias.kind !== "ok" || two.kind !== "ok") throw new Error("seed pins failed");
    expect(value.service.resources().readerPinBytes).toBe(192 * 1024 * 1024);
    expect(await value.workspace.pin("/three")).toEqual({ kind: "pressure", resource: "pin-bytes" });
    await one.value.close();
    expect(value.service.resources().readerPinBytes).toBe(192 * 1024 * 1024);
    await alias.value.close();
    const third = await value.workspace.pin("/three");
    expect(third.kind).toBe("ok");
    if (third.kind === "ok") await third.value.close();
    await two.value.close();
    expect(value.service.resources().readerPinBytes).toBe(0);
    expect(value.backend.shared.registeredHandles()).toHaveLength(0);
  } finally { await value.close(); }
});

test("publication refusal rolls back growth and COW reservations before any effect", async () => {
  const value = await residentReadFixture(PAGE * 2);
  const domain = value.backend.shared.publication!;
  const original = domain.prepare;
  const refused = new Error("held publication capacity");
  try {
    const lease = await value.workspace.pin("/file");
    if (lease.kind !== "ok") throw new Error(lease.kind);
    const before = value.backend.shared.resources().usedBytes;
    const stat = value.backend.shared.stat(value.handle), identity = value.backend.identity(value.handle), cut = domain.cut();
    domain.prepare = () => { throw refused; };
    const failure = await value.client.asyncCall("write", [value.handle, PAGE * 3], new Uint8Array([90])).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ message: refused.message });
    expect(value.backend.shared.resources().usedBytes).toBe(before);
    expect(value.backend.shared.stat(value.handle)).toEqual(stat);
    expect(value.backend.identity(value.handle)).toEqual(identity);
    expect(domain.cut()).toEqual(cut);
    domain.prepare = original;
    await value.client.asyncCall("write", [value.handle, PAGE * 3], new Uint8Array([90]));
    const old = await lease.value.read({ offset: PAGE, length: 1 });
    expect(old.kind).toBe("ok");
    if (old.kind === "ok") expect(old.value.bytes[0]).toBe(65);
    await lease.value.close();
  } finally { domain.prepare = original; await value.close(); }
});

test("public selection excludes real pending resident grants and old leases survive committed import", async () => {
  const value = await residentReadFixture(PAGE * 3);
  let descriptor: ResidentDescriptor | undefined;
  try {
    descriptor = await value.client.asyncCall("publicationResident", [value.client.connection.publication!.observer, value.handle, `public-read-${crypto.randomUUID()}`]);
    const authority = value.service.residentPublication!;
    authority.activate();
    const session = authority.open(descriptor!);
    const opened = await value.workspace.pin("/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    const cell = new ResidentGrantCell(authority.prepare(session, { kind: "write", offset: PAGE * 2, maxBytes: 1 }));
    expect(cell.snapshot().kind).toBe("ready");
    expect(await value.workspace.read("/file", { offset: PAGE * 2, length: 1 })).toEqual({ kind: "unavailable" });
    expect(cell.tryWrite(value.handle, [new Uint8Array([90])], PAGE * 2)).toBe(1);
    expect(cell.snapshot().kind).toBe("committed");
    expect(await value.workspace.stat("/file")).toEqual({ kind: "unavailable" });
    expect(authority.settle(session, cell.snapshot()).kind).toBe("committed");
    const current = await value.workspace.read("/file", { offset: PAGE * 2, length: 1 }), old = await opened.value.read({ offset: PAGE * 2, length: 1 });
    expect(current.kind).toBe("ok");
    expect(old.kind).toBe("ok");
    if (current.kind === "ok" && old.kind === "ok") {
      expect(current.value.bytes[0]).toBe(90);
      expect(old.value.bytes[0]).toBe(65);
      expect(current.value.stat.id).toBe(old.value.stat.id);
      expect(current.value.stat.version).not.toBe(old.value.stat.version);
    }
    await opened.value.close();
    authority.close(session);
  } finally {
    value.service.residentPublication?.dispose();
    await value.close();
  }
});
