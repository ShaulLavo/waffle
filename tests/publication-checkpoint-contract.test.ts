import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../fs";
import {
  decodeEffects,
  encodeEffects,
  snapshotPublicationCheckpoint,
  type PublicationEffect,
} from "../fs/publication";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";
import type { CheckpointPublication } from "../fs/storage";

const limits: PublicationLimits = {
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

async function checkpointFixture(): Promise<CheckpointPublication> {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  try {
    const root: number = await client.asyncCall("preopen", ["/"]);
    const observer = publicationObserver(client);
    const start = await observer.cut();
    await client.asyncCall("writeFile", ["/file"], new Uint8Array([1, 2, 3]));
    await client.asyncCall("setMtime", [root, 42]);
    const cut = await observer.cut();
    const page = await observer.changes(start, limits.logBytes);
    if (page.kind !== "changes") throw new Error("fixture lost its publication suffix");
    const content = page.publications[0]?.changes.find((effect) => effect.kind === "bytes");
    if (content?.kind !== "bytes") throw new Error("fixture has no content write");
    return {
      kind: "settled-publication-v1",
      cut,
      sessionSerial: 65536,
      limits,
      receipts: page.publications.map((publication) => publication.receipt),
      changes: page.publications.map((publication) =>
        encodeEffects(publication.receipt, publication.changes, limits.effectBytes),
      ),
      contentVersions: [{ ino: content.file.ino, version: content.version }],
    };
  } finally {
    client.dispose();
    service.dispose();
  }
}

function withContent(
  checkpoint: CheckpointPublication,
  kind: "bytes" | "resize",
  fields: Partial<{ size: number; offset: number; version: number }>,
): CheckpointPublication {
  const publication = decodeEffects(checkpoint.changes[0]!);
  expect(publication.changes.some((effect) => effect.kind === kind)).toBe(true);
  const changes: PublicationEffect[] = publication.changes.map((effect) =>
    effect.kind === kind ? { ...effect, ...fields } : effect,
  );
  return {
    ...checkpoint,
    changes: [encodeEffects(publication.receipt, changes, limits.effectBytes)].concat(
      checkpoint.changes.slice(1),
    ),
  };
}

test("checkpoint changes own their bytes without invoking caller copy hooks", async () => {
  const checkpoint = await checkpointFixture();
  const original = checkpoint.changes[0]!;
  const expected = new Uint8Array(original);
  let sliceCalls = 0;
  Object.defineProperty(original, "slice", {
    value() {
      sliceCalls++;
      return original;
    },
  });
  Object.defineProperty(original, "constructor", {
    get() {
      throw new Error("checkpoint consulted caller constructor/species");
    },
  });
  const snapshot = snapshotPublicationCheckpoint(checkpoint);
  expect(sliceCalls).toBe(0);
  expect(snapshot.changes[0]).not.toBe(original);
  expect(snapshot.changes[0]!.buffer).not.toBe(original.buffer);
  original.fill(0);
  expect(snapshot.changes[0]).toEqual(expected);
  expect(snapshot.sessionSerial).toBe(65536);
  expect(snapshot.contentVersions).toEqual(checkpoint.contentVersions);
});

test.each([
  { kind: "bytes", fields: { size: -1 } },
  { kind: "bytes", fields: { size: 1.5 } },
  { kind: "bytes", fields: { size: Number.MAX_SAFE_INTEGER + 1 } },
  { kind: "bytes", fields: { offset: -4 } },
  { kind: "bytes", fields: { offset: 0.5 } },
  { kind: "bytes", fields: { offset: Number.MAX_SAFE_INTEGER + 1 } },
  { kind: "bytes", fields: { offset: 1 } },
  { kind: "bytes", fields: { version: -1 } },
  { kind: "bytes", fields: { version: 0.5 } },
  { kind: "resize", fields: { size: -1 } },
  { kind: "resize", fields: { size: 1.5 } },
  { kind: "resize", fields: { size: Number.MAX_SAFE_INTEGER + 1 } },
  { kind: "resize", fields: { version: -1 } },
  { kind: "resize", fields: { version: 0.5 } },
] satisfies { kind: "bytes" | "resize"; fields: Parameters<typeof withContent>[2] }[])(
  "checkpoint rejects invalid content counters %j",
  async ({ kind, fields }) => {
    const checkpoint = withContent(await checkpointFixture(), kind, fields);
    expect(() => snapshotPublicationCheckpoint(checkpoint)).toThrow();
  },
);

test.each(["bytes", "resize"] as const)(
  "checkpoint rejects %s versions newer than the effect publication cut",
  async (kind) => {
    const checkpoint = await checkpointFixture();
    const publication = decodeEffects(checkpoint.changes[0]!);
    expect(publication.receipt.cut.generation).toBeLessThan(checkpoint.cut.generation);
    for (const version of [publication.receipt.cut.generation + 1, checkpoint.cut.generation + 1])
      expect(() =>
        snapshotPublicationCheckpoint(withContent(checkpoint, kind, { version })),
      ).toThrow();
  },
);

test("checkpoint accepts lagging content versions, zero resize and full safe integer sizes", async () => {
  const checkpoint = await checkpointFixture();
  expect(snapshotPublicationCheckpoint(checkpoint)).toEqual(checkpoint);
  const bytes = decodeEffects(checkpoint.changes[0]!).changes.find(
    (effect) => effect.kind === "bytes",
  );
  if (bytes?.kind !== "bytes") throw new Error("fixture has no content write");
  expect(bytes.version).toBeLessThan(checkpoint.cut.generation);
  for (const size of [0, Number.MAX_SAFE_INTEGER])
    expect(
      snapshotPublicationCheckpoint(withContent(checkpoint, "resize", { size })),
    ).toBeDefined();
  expect(
    snapshotPublicationCheckpoint(
      withContent(checkpoint, "bytes", {
        offset: Number.MAX_SAFE_INTEGER - bytes.bytes.length,
        size: Number.MAX_SAFE_INTEGER,
      }),
    ),
  ).toBeDefined();
});
