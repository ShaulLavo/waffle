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
import {
  decodeSnapshot,
  encodeRecord,
  encodeSnapshot,
  type CheckpointPublication,
} from "../fs/storage";
import { coldPublicationRoot } from "./fixtures/publication-storage";

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

test("publication snapshots preserve typed bytes and reject invalid records", async () => {
  const publication = await checkpointFixture();
  const value = { ...coldPublicationRoot(), publication };
  const snapshot = await encodeSnapshot(value);
  const decoded = await decodeSnapshot(snapshot);
  expect(decoded).toEqual(value);
  for (const [index, change] of publication.changes.entries()) {
    expect(decoded?.publication?.changes[index]).toBeInstanceOf(Uint8Array);
    expect(decoded?.publication?.changes[index]).toEqual(change);
  }
  expect(
    await decodeSnapshot({
      ...snapshot,
      json: snapshot.json.replace('"generation":1', '"generation":2'),
    }),
  ).toBeUndefined();
  const invalidBytes = {
    ...value,
    publication: { ...publication, changes: [[0, 256]] },
  };
  expect(await decodeSnapshot(await encodeRecord(invalidBytes))).toBeUndefined();
  const withoutPublication = coldPublicationRoot();
  expect(await decodeSnapshot(await encodeSnapshot(withoutPublication))).toEqual(
    withoutPublication,
  );
});

test.each([
  {
    name: "change count",
    limits: { effectBytes: limits.effectBytes, logRecords: 1 },
    changes: [[1], [1]],
  },
  {
    name: "change bytes",
    limits: { effectBytes: 1, logRecords: limits.logRecords },
    changes: [[1, 2]],
  },
])(
  "publication snapshots reject over-limit $name before typed byte conversion",
  async ({ limits: declaredLimits, changes }) => {
    const checkpoint = await checkpointFixture();
    const record = await encodeRecord({
      ...coldPublicationRoot(),
      publication: {
        ...checkpoint,
        limits: { ...checkpoint.limits, ...declaredLimits },
        changes,
      },
    });
    const originalFrom = Uint8Array.from;
    const originalDescriptor = Object.getOwnPropertyDescriptor(Uint8Array, "from");
    let conversionCalls = 0;
    Object.defineProperty(Uint8Array, "from", {
      configurable: true,
      writable: true,
      value: function (...args: Parameters<typeof Uint8Array.from>) {
        conversionCalls++;
        return Reflect.apply(originalFrom, Uint8Array, args);
      },
    });
    try {
      expect(await decodeSnapshot(record)).toBeUndefined();
      expect(conversionCalls).toBe(0);
    } finally {
      if (originalDescriptor) Object.defineProperty(Uint8Array, "from", originalDescriptor);
      else Reflect.deleteProperty(Uint8Array, "from");
    }
  },
);

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

function withEncodedRange(
  checkpoint: CheckpointPublication,
  at: string,
  length: string,
): CheckpointPublication {
  const original = checkpoint.changes[0]!;
  const headerLength = new DataView(
    original.buffer,
    original.byteOffset,
    original.byteLength,
  ).getUint32(0, true);
  const header = new TextDecoder().decode(original.subarray(4, 4 + headerLength));
  const range = /"bytes":\{"at":\d+,"length":\d+\}/g;
  expect(header.match(range)).toHaveLength(1);
  const encoded = new TextEncoder().encode(
    header.replace(range, `"bytes":{"at":${at},"length":${length}}`),
  );
  const tail = original.subarray(4 + headerLength);
  const bytes = new Uint8Array(4 + encoded.length + tail.length);
  new DataView(bytes.buffer).setUint32(0, encoded.length, true);
  bytes.set(encoded, 4);
  bytes.set(tail, 4 + encoded.length);
  const changes: Uint8Array[] = [bytes];
  return { ...checkpoint, changes: changes.concat(checkpoint.changes.slice(1)) };
}

test.each([
  { at: "0", length: "0.5" },
  { at: "0.5", length: "1" },
  { at: "1e400", length: "0" },
  { at: "-1e400", length: "0" },
  { at: "0", length: "1e400" },
  { at: "0", length: "-1e400" },
  { at: "9007199254740992", length: "0" },
  { at: "0", length: "9007199254740992" },
  { at: "-1", length: "1" },
  { at: "0", length: "-1" },
  { at: "4", length: "0" },
  { at: "1", length: "3" },
])("encoded content ranges reject invalid byte indexes %j", async ({ at, length }) => {
  const checkpoint = withEncodedRange(await checkpointFixture(), at, length);
  expect(() => decodeEffects(checkpoint.changes[0]!)).toThrow(
    expect.objectContaining({ errno: 29 }),
  );
  expect(() => snapshotPublicationCheckpoint(checkpoint)).toThrow(
    expect.objectContaining({ errno: 29 }),
  );
});

test.each([
  { at: "0", length: "0", bytes: [] },
  { at: "3", length: "0", bytes: [] },
  { at: "0", length: "3", bytes: [1, 2, 3] },
  { at: "1", length: "2", bytes: [2, 3] },
])("encoded content ranges preserve valid tail bounds %j", async ({ at, length, bytes }) => {
  const checkpoint = withEncodedRange(await checkpointFixture(), at, length);
  const snapshot = snapshotPublicationCheckpoint(checkpoint);
  const effect = decodeEffects(snapshot.changes[0]!).changes.find(
    (effect) => effect.kind === "bytes",
  );
  if (effect?.kind !== "bytes") throw new Error("fixture has no content write");
  expect(effect.bytes).toEqual(Uint8Array.from(bytes));
});
