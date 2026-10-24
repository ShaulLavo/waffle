import { expect, test } from "bun:test";
import {
  MemoryBackend,
  FilesystemClient,
  FilesystemService,
  createFilesystemConnection,
} from "../fs";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";
import {
  createPublicationBuffers,
  PublicationDomain,
  snapshotPublicationCheckpoint,
  decodeEffects,
} from "../fs/publication";
import { snapshotBatch } from "../fs/storage";
const smallLimits: PublicationLimits = {
  sessions: 4,
  operations: 4,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 2,
  logBytes: 8192,
  pins: 1,
  pinBytes: 64,
};
test("real publication checkpoint owns bounded receipts, gap suffix and content counters", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, {
    limits: smallLimits,
    observe: true,
    restore: {
      kind: "settled-publication-v1",
      cut: { history: crypto.randomUUID(), generation: 0 },
      sessionSerial: 0,
      limits: smallLimits,
      receipts: [],
      changes: [],
      contentVersions: [],
    },
  });
  const client = new FilesystemClient(connection.client);
  service.connect(connection.server);
  try {
    const observer = publicationObserver(client),
      original = await observer.cut();
    await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
    const firstPage = await observer.changes(original, smallLimits.logBytes);
    if (firstPage.kind !== "changes" || !firstPage.publications[0])
      throw new Error("real publication absent");
    const firstReceipt = firstPage.publications[0].receipt;
    for (let value = 2; value <= 8; value++)
      await client.asyncCall("writeFile", ["/file"], new Uint8Array([value]));
    const captured = backend.shared.current(true, undefined, client.connection.owner, () =>
      backend.shared.publication!.checkpoint(),
    );
    expect(captured.receipts.length).toBeLessThanOrEqual(4);
    expect(captured.changes).toHaveLength(2);
    const batch = snapshotBatch({
      generation: 1,
      root: 1,
      upserts: [],
      removes: [],
      data: new Map(),
      publication: captured,
    });
    const owned = batch.publication;
    if (!owned) throw new Error("checkpoint missing from owned batch");
    const saved = structuredClone(owned);
    const live = backend.shared.publication!;
    const fixed = live.checkpointMetadataBytes(0);
    const latestChange = captured.changes.at(-1);
    if (!latestChange) throw new Error("latest change absent");
    const bounded = live.checkpoint(fixed + latestChange.length * 16);
    expect(live.checkpointMetadataBytes(fixed + latestChange.length * 16)).toBe(
      fixed + latestChange.length * 16,
    );
    expect(bounded.changes).toEqual([latestChange]);
    expect(bounded.receipts).toEqual(captured.receipts);
    expect(bounded.contentVersions).toEqual(captured.contentVersions);
    const boundedRestore = new PublicationDomain(
      createPublicationBuffers(smallLimits, false, { checkpoint: bounded }),
    );
    expect(boundedRestore.cut()).toEqual(captured.cut);
    expect(boundedRestore.changes(original, 8192)).toEqual({ kind: "gap", current: captured.cut });
    const suffix = boundedRestore.changes(
      { ...captured.cut, generation: captured.cut.generation - 1 },
      8192,
    );
    expect(suffix.kind).toBe("changes");
    if (suffix.kind !== "changes") throw new Error("retained suffix lost");
    expect(suffix.publications.map((value) => value.receipt.cut.generation)).toEqual([
      captured.cut.generation,
    ]);
    for (const receipt of captured.receipts)
      expect(boundedRestore.lookupAny(receipt.id)).toEqual({ kind: "committed", receipt });
    for (const entry of captured.contentVersions)
      expect(boundedRestore.contentVersion(entry.ino)).toBe(entry.version);
    expect(boundedRestore.openSession().serial).toBeGreaterThan(bounded.sessionSerial);
    const empty = live.checkpoint(fixed);
    expect(empty.changes).toEqual([]);
    const emptyRestore = new PublicationDomain(
      createPublicationBuffers(smallLimits, false, { checkpoint: empty }),
    );
    expect(emptyRestore.changes(original, 8192)).toEqual({ kind: "gap", current: captured.cut });
    expect(emptyRestore.changes(captured.cut, 8192)).toMatchObject({
      kind: "changes",
      publications: [],
    });
    expect(live.checkpoint().changes).toEqual(captured.changes);
    const postCutSession = live.openSession();
    const postCutId = live.next(postCutSession);
    captured.changes[0]?.fill(0);
    expect(owned).toEqual(saved);
    const restored = new PublicationDomain(
      createPublicationBuffers(smallLimits, false, { checkpoint: owned }),
    );
    expect(restored.cut()).toEqual(saved.cut);
    expect(restored.changes(original, 8192)).toEqual({ kind: "gap", current: saved.cut });
    expect(restored.lookupAny(firstReceipt.id)).toEqual({ kind: "unknown" });
    for (const receipt of saved.receipts)
      expect(restored.lookupAny(receipt.id)).toEqual({ kind: "committed", receipt });
    for (const entry of saved.contentVersions)
      expect(restored.contentVersion(entry.ino)).toBe(entry.version);
    const diagnostics = restored.diagnostics();
    expect(diagnostics.sessions).toBe(0);
    expect(diagnostics.pending).toBe(0);
    expect(diagnostics.pins).toBe(0);
    const oldSession = connection.client.publication?.session;
    if (!oldSession) throw new Error("root session absent");
    expect(() => restored.next(oldSession)).toThrow();
    const session = restored.openSession();
    expect(session.serial).toBeGreaterThan(saved.sessionSerial);
    expect(session.serial).toBeGreaterThan(postCutId.session);
    expect(restored.lookupAny(postCutId)).toEqual({ kind: "unknown" });
    live.closeSession(postCutSession);
    for (let index = 0; index < 8; index++) {
      const id = restored.next(session);
      const admission = restored.admit(
        session,
        id,
        { kind: "preopen", path: "/" },
        new Uint8Array(),
      );
      if (admission.kind !== "admitted") throw new Error("fresh receipt unexpectedly duplicated");
      restored.commit(restored.prepare(admission.admission, { kind: "void" }, []));
    }
    for (const receipt of saved.receipts)
      expect(restored.lookupAny(receipt.id)).toEqual({ kind: "unknown" });
    expect(() =>
      snapshotPublicationCheckpoint({ ...saved, receipts: saved.receipts.concat(saved.receipts) }),
    ).toThrow();
    expect(() => snapshotPublicationCheckpoint({ ...saved, sessionSerial: 0 })).toThrow();
    expect(() =>
      snapshotPublicationCheckpoint({
        ...saved,
        cut: { ...saved.cut, history: "x".repeat(257) },
      }),
    ).toThrow();
    expect(() =>
      snapshotPublicationCheckpoint({ ...saved, changes: saved.changes.toReversed() }),
    ).toThrow();
    expect(() =>
      createPublicationBuffers({ ...smallLimits, operations: 5 }, false, { checkpoint: saved }),
    ).toThrow();
    const exhausted = new PublicationDomain(
      createPublicationBuffers(smallLimits, false, {
        checkpoint: { ...saved, sessionSerial: 0x7ffffffd },
      }),
    );
    expect(exhausted.openSession().serial).toBe(0x7ffffffe);
    const beforeExhaustion = exhausted.checkpoint();
    const arenas = [
      exhausted.buffers.control,
      exhausted.buffers.sessions,
      exhausted.buffers.operations,
    ];
    const beforeArenas = arenas.map((buffer) => Array.from(new Uint8Array(buffer)));
    expect(() => exhausted.openSession()).toThrow();
    expect(arenas.map((buffer) => Array.from(new Uint8Array(buffer)))).toEqual(beforeArenas);
    expect(exhausted.checkpoint()).toEqual(beforeExhaustion);
    expect(createPublicationBuffers(smallLimits).sessionLimit).toBe(0x7ffffffe);
    expect(() =>
      createPublicationBuffers(smallLimits, false, { checkpoint: beforeExhaustion }),
    ).toThrow();
    const first = saved.changes[0];
    if (!first) throw new Error("saved suffix absent");
    expect(decodeEffects(first).receipt.cut.generation).toBe(saved.cut.generation - 1);
  } finally {
    client.dispose();
    service.dispose();
  }
});
