import { expect, test } from "bun:test";
import { OpfsStorage } from "../fs/opfs";
import { PersistentBackend } from "../fs/persistent";
import { identityOpfsFixture } from "./fixtures/durable-identity-opfs";
import { MAX_IDENTITY_PART } from "../fs/file-identity";

for (const stage of ["create", "open", "flush", "close", "remove", "removed"] as const) {
  test(`OPFS ambiguous reservation ${stage} interruption retains nonreuse highwater with bounded markers`, async () => {
    const fixture = identityOpfsFixture();
    let storage = await OpfsStorage.open("identity", fixture);
    const first = await storage.reserveIdentity();
    let interrupted = false;
    fixture.fault((operation, name) => {
      if (interrupted || operation !== stage || !name.startsWith("identity-")) return;
      if (stage !== "remove" && stage !== "removed" && name.endsWith("-1")) return;
      interrupted = true;
      throw new Error(`interrupted ${stage}`);
    });
    let failure: unknown;
    try {
      await storage.reserveIdentity(first.workspace);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    fixture.fault();
    if (stage === "close") {
      let debt: unknown;
      try {
        await storage.close();
      } catch (error) {
        debt = error;
      }
      expect(debt).toBe(failure);
    } else await storage.close();
    const witnessed = fixture.markers().map((name) => BigInt(`0x${name.split("-").at(-1)}`));
    const highwater = witnessed.reduce((a, b) => (a > b ? a : b), 0n);
    storage = await OpfsStorage.open("identity", fixture);
    try {
      const next = await storage.reserveIdentity(first.workspace);
      expect(next.era).toBeGreaterThan(highwater);
      expect(next.workspace).toBe(first.workspace);
      expect(fixture.markers()).toHaveLength(1);
      for (let index = 0; index < 5; index++) await storage.reserveIdentity(first.workspace);
      expect(fixture.markers()).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });
}

test("OPFS rollback root does not roll allocation era back", async () => {
  const fixture = identityOpfsFixture();
  let storage = await OpfsStorage.open("rollback", fixture);
  let backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  backend.execute("writeFile", ["/saved"], new Uint8Array([1]));
  const saved = backend.identity(backend.fs.handleForNode(backend.fs.lookup("/saved")!));
  await backend.flush();
  backend.execute("writeFile", ["/discarded"], new Uint8Array([2]));
  const discarded = backend.identity(backend.fs.handleForNode(backend.fs.lookup("/discarded")!));
  backend.dispose();
  await storage.close();
  storage = await OpfsStorage.open("rollback", fixture);
  backend = await PersistentBackend.open(storage, { intervalMs: 0 });
  try {
    expect(backend.identity(backend.fs.handleForNode(backend.fs.lookup("/saved")!))).toEqual(saved);
    expect(backend.fs.lookup("/discarded")).toBeUndefined();
    backend.execute("writeFile", ["/new"], new Uint8Array([3]));
    expect(backend.identity(backend.fs.handleForNode(backend.fs.lookup("/new")!)).id).not.toBe(
      discarded.id,
    );
    expect(fixture.markers()).toHaveLength(1);
  } finally {
    backend.dispose();
    await storage.close();
  }
});

test("OPFS marker exhaustion and malformed or mixed-workspace metadata fail closed", async () => {
  const fixture = identityOpfsFixture();
  let storage = await OpfsStorage.open("bad", fixture);
  const original = await storage.reserveIdentity();
  await storage.close();
  fixture.corrupt(`identity-${original.workspace}-${MAX_IDENTITY_PART.toString(16)}`);
  storage = await OpfsStorage.open("bad", fixture);
  try {
    let exhausted: unknown;
    try {
      await storage.reserveIdentity();
    } catch (error) {
      exhausted = error;
    }
    expect(exhausted).toMatchObject({ errno: 33 });
    expect(fixture.markers()).toHaveLength(2);
  } finally {
    await storage.close();
  }
  fixture.corrupt(`identity-${crypto.randomUUID()}-1`);
  storage = await OpfsStorage.open("bad", fixture);
  try {
    let corrupt: unknown;
    try {
      await storage.reserveIdentity();
    } catch (error) {
      corrupt = error;
    }
    expect(corrupt).toBeInstanceOf(Error);
    expect(fixture.markers()).toHaveLength(3);
  } finally {
    await storage.close();
  }
});
