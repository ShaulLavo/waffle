import { expect, test } from "bun:test";
import { encodeRecord } from "../fs/storage.js";
import {
  initialEnvelope,
  encodeCommit,
  decodeCommit,
  operationKey,
  prepareDurableGroup,
  validateGroup,
  StagingCapacity,
  StagedCommitDriver,
  type CompleteStage,
  type CommittedStorage,
} from "../fs/safe-staging.js";
import { runSafeStagingNative } from "./safe-staging-native.js";

const request = { digest: "a".repeat(64), length: 1 };
const recovery = () => ({ envelope: initialEnvelope(1), epoch: 1, index: undefined });
function stage(): CompleteStage {
  return {
    batch: {
      generation: 1,
      root: 1,
      upserts: [{ ino: 1, kind: "dir", size: 0, mtime: 0, children: [] }],
      removes: [],
      data: new Map(),
    },
    cut: { history: "history", generation: 0 },
    result: { kind: "value", value: null },
    retained: [],
    orphans: [],
    publish() {},
    release() {},
  };
}
test("staged envelope roundtrips canonical counters and rejects corrupt or noncanonical heads", async () => {
  const original = recovery();
  const group = await prepareDurableGroup(original, operationKey(1n, 1n), request, stage());
  expect((await decodeCommit(group.envelope)).head.sequence === 1n).toBe(true);
  expect(await validateGroup(group, original)).toEqual(await decodeCommit(group.envelope));
  await expect(decodeCommit({ ...group.envelope, checksum: "bad" })).rejects.toThrow(
    "required staged",
  );
  const value = JSON.parse(group.envelope.json);
  value.head.sequence = "01";
  await expect(decodeCommit(await encodeRecord(value))).rejects.toThrow("required staged");
});
test("genesis identity and receipt transitions cannot be forged", async () => {
  const original = recovery();
  const group = await prepareDurableGroup(original, operationKey(1n, 1n), request, stage());
  const next = await decodeCommit(group.envelope);
  const forged = await encodeCommit({ ...next, head: { ...next.head, workspace: "different" } });
  await expect(validateGroup({ ...group, envelope: forged }, original)).rejects.toThrow(
    "required staged",
  );
  await expect(
    prepareDurableGroup(original, operationKey(2n, 1n), request, stage()),
  ).rejects.toThrow("required staged");
  expect(() => operationKey(1n, 0n)).toThrow();
  expect(() => operationKey(1n << 128n, 1n)).toThrow();
});
test("admission bounds run before producer allocation", async () => {
  let prepared = 0;
  const storage: CommittedStorage = {
    async recoverCommitted() {
      return recovery();
    },
    beginCommit() {
      throw new Error("not admitted");
    },
    async read() {
      throw new Error("unused");
    },
    async readRange() {
      throw new Error("unused");
    },
    retainPayload() {
      throw new Error("unused");
    },
    async close() {},
  };
  const driver = await StagedCommitDriver.open(storage, { bytes: 128, metadataBytes: 64 });
  const outcome = await driver.submit({
    key: operationKey(1n, 1n),
    request,
    charge: { inputBytes: 1, payloadBytes: 1, metadataBytes: 1, publicationBytes: 1 },
    async prepare() {
      prepared++;
      return stage();
    },
  });
  expect(outcome.kind).toBe("not-admitted");
  if (outcome.kind === "not-admitted") expect(outcome.cause).toBeInstanceOf(StagingCapacity);
  expect(prepared).toBe(0);
  expect(driver.resources().debtBytes).toBe(0);
});
if (process.env.SAFE_STAGING_ENGINE) {
  test("native staged adapter causal controls", async () => {
    await runSafeStagingNative(process.env.SAFE_STAGING_ENGINE!, process.env.SAFE_STAGING_CONTROL);
  }, 180_000);
}
