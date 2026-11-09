import { afterEach, expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors";
import {
  MissingDataError,
  PersistentBackend,
  SharedFilesystemState,
  createFilesystemIdentity,
  reapFilesystem,
  revokeFilesystem,
  type FilesystemClient,
} from "../fs";
import { DirtyCapacityError } from "../fs/dirty-admission";
import { nextReservation, storeReservation, type StoredReservation } from "../fs/file-identity";
import { State } from "../fs/protocol";
import type { PersistenceBatch, PersistedIndex, StorageBackend } from "../fs/storage";
import { CommandStdio } from "../proc/command-stdio";
import { fixturePayloadHooks } from "./fixtures/publication-storage";
import { requestBudgetBytes, requestMemorySections } from "../fs/request-memory";
import { SLOT_WORDS } from "../fs/shared";
import { DATA_PAGES_PER_SEGMENT, MAX_FILES } from "../fs/storage-geometry";
import {
  DATA_PAGE_BYTES as PAGE,
  SHARED_SEGMENT_BYTES,
  attachedClient,
  createRig,
  fillFirstSegment,
  holdOwner,
  readFile,
  resolveNode,
  settle,
  unattachedClient,
  unattachedConnection,
  untilReady,
  withoutWaiting,
  type Cleanup,
  type Rig,
} from "./fixtures/lazy-backing.js";

const cleanups: Cleanup[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const REVISION_STATE = 11;
const file = (ino: number, size: number) => ({
  kind: "file" as const,
  ino,
  nlink: 1,
  size,
  mtime: 1,
  mode: 0o644,
});
/** `/target` lives wholly in segment 1, which only the owner and yielding clients hold. Its
 * capacity is `capacity` pages, so a write inside that needs no growth first. */
async function target(rig: Rig, pages = 2, capacity = pages): Promise<number> {
  // A publication bounds each input, so there the first segment is marked taken instead of
  // filled by one 16 MiB write. Either way the allocator's next page is the first of segment 1.
  if (rig.backend.shared.publication) rig.backend.shared.owners.fill(1, 0, DATA_PAGES_PER_SEGMENT);
  else await fillFirstSegment(rig);
  await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(PAGE * pages).fill(0x11));
  const node = await resolveNode(rig.client, "target");
  rig.client.retain(node);
  if (capacity > pages) await rig.client.asyncCall("grow", [node, PAGE * capacity]);
  await settle();
  return node;
}
/** The first call of an immediate write to an unattached segment, and the wait poll would do. */
async function stage(
  fs: FilesystemClient,
  node: number,
  bytes: Uint8Array,
  offset: number,
): Promise<void> {
  expect(withoutWaiting(() => fs.tryWrite(node, [bytes], offset))).toBe(-6);
  await untilReady(fs, node, true);
}
/** An attached client sees the bytes directly, with no owner operation that could apply them. */
function directBytes(peer: { fs: FilesystemClient; node: number }, offset: number, length: number) {
  const bytes = new Uint8Array(length);
  const count = peer.fs.tryRead(peer.node, [bytes], offset);
  return { count, bytes };
}

/** Whether the file is gated for an attached agent, observed without any owner operation. */
function awaitsOwner(peer: { fs: FilesystemClient; node: number }): boolean {
  const shared = peer.fs.shared;
  try {
    shared.directRead(
      shared.fileSlot(peer.node),
      peer.node,
      [new Uint8Array(1)],
      0,
      () => false,
      peer.fs.connection.owner,
      true,
    );
    return false;
  } catch (error) {
    if (error instanceof MissingDataError) return true;
    throw error;
  }
}

test("an immediate write to an unattached segment never waits for a held owner", async () => {
  const rig = createRig(3, cleanups);
  await target(rig);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  const used = owner.resources().usedBytes;
  const retained = requestBudgetBytes(rig.identity.requestBudget);
  const hold = holdOwner(rig.service, ["stageWrite"]);
  const bytes = new Uint8Array(PAGE).fill(0x22);
  expect(withoutWaiting(() => fs.tryWrite(node, [bytes], 0))).toBe(-6);
  await hold.entered;
  // A retry while the owner is held submits nothing new and still does not wait.
  const outstanding = fs.completions.size;
  expect(withoutWaiting(() => fs.tryWrite(node, [bytes], 0))).toBe(-6);
  expect(fs.completions.size).toBe(outstanding);
  expect(fs.ioReadiness(node, true).writable).toBe(false);
  await settle(1);
  expect(owner.revision(node)).toBe(before);
  hold.release();
  await untilReady(fs, node, true);
  // Staging changed no byte, no size and no revision, and took no filesystem page. The owner
  // holds one private copy, charged to the connection's existing retained-bytes budget.
  expect(owner.revision(node)).toBe(before);
  expect(owner.resources().usedBytes).toBe(used);
  const staged = requestBudgetBytes(rig.identity.requestBudget);
  expect(staged).toBeGreaterThanOrEqual(retained + PAGE);
  // The retry commits in this one call, in attached metadata.
  expect(withoutWaiting(() => fs.tryWrite(node, [bytes], 0))).toBe(PAGE);
  expect(owner.revision(node)).toBe(before + 1);
  expect(fs.shared.segments).toHaveLength(1);
  // One owner turn later the write is applied and the private copy is refunded.
  await settle();
  expect(requestBudgetBytes(rig.identity.requestBudget)).toBe(staged - PAGE);
  expect(owner.revision(node)).toBe(before + 1);
  expect(owner.isResident(node)).toBe(true);
  expect(owner.resources().usedBytes).toBe(used);
  const stored = await readFile(rig, "/target");
  expect(stored[0]).toBe(0x22);
  expect(stored[PAGE - 1]).toBe(0x22);
  expect(stored[PAGE]).toBe(0x11);
});

test("a write that also needs growth reserves capacity, then stages, then commits", async () => {
  const rig = createRig(3, cleanups);
  await target(rig);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  const bytes = new Uint8Array(PAGE).fill(0x29);
  const submitted: string[] = [];
  const submit = fs.submit.bind(fs);
  fs.submit = (...args) => {
    submitted.push(args[0]);
    return submit(...args);
  };
  // Poll and retry until the write is accepted, as a guest does. No call waits for the owner.
  let result = -6;
  for (let attempt = 0; attempt < 8 && result === -6; attempt++) {
    result = withoutWaiting(() => fs.tryWrite(node, [bytes], PAGE * 5));
    if (result === -6) await untilReady(fs, node, true);
  }
  expect(result).toBe(PAGE);
  expect(submitted).toEqual(["grow", "stageWrite"]);
  expect(owner.revision(node)).toBe(before + 1);
  const stored = await readFile(rig, "/target");
  expect(stored).toHaveLength(PAGE * 6);
  expect(stored.subarray(PAGE * 2, PAGE * 5).every((byte) => byte === 0)).toBe(true);
  expect(stored.subarray(PAGE * 5).every((byte) => byte === 0x29)).toBe(true);
});

test("every direct path goes to the owner between the commit and the owner's apply", async () => {
  const rig = createRig(3, cleanups);
  await target(rig, 2, 4);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const reader = await attachedClient(rig, "target", cleanups);
  const writer = await attachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  expect(directBytes(reader, 0, 4).bytes).toEqual(new Uint8Array(4).fill(0x11));
  const bytes = new Uint8Array(PAGE + 100).fill(0x22);
  await stage(fs, node, bytes, PAGE * 2 - 50);
  const before = owner.revision(node)!;
  expect(fs.tryWrite(node, [bytes], PAGE * 2 - 50)).toBe(bytes.length);
  // No event-loop turn has run, so the owner has not applied the write yet. Metadata is direct
  // and already shows it. Data is not: an attached reader must not see the older bytes.
  expect(reader.fs.stat(node).size).toBe(PAGE * 3 + 50);
  expect(owner.revision(node)).toBe(before + 1);
  const destination = new Uint8Array(PAGE).fill(0x7f);
  expect(reader.fs.tryRead(node, [destination], PAGE)).toBe(-6);
  expect(destination.every((byte) => byte === 0x7f)).toBe(true);
  expect(reader.fs.ioReadiness(node, false).readable).toBe(false);
  expect(writer.fs.tryWrite(node, [new Uint8Array(8).fill(0x33)], 0)).toBe(-6);
  expect(owner.revision(node)).toBe(before + 1);
  // Both become ready through the owner, which applies the committed write first.
  await untilReady(reader.fs, node, false);
  expect(reader.fs.tryRead(node, [destination], PAGE)).toBe(PAGE);
  expect(destination.subarray(0, PAGE - 50).every((byte) => byte === 0x11)).toBe(true);
  expect(destination.subarray(PAGE - 50).every((byte) => byte === 0x22)).toBe(true);
  await untilReady(writer.fs, node, true);
  expect(writer.fs.tryWrite(node, [new Uint8Array(8).fill(0x33)], 0)).toBe(8);
  const stored = await readFile(rig, "/target");
  expect(stored).toHaveLength(PAGE * 3 + 50);
  expect(stored[0]).toBe(0x33);
  expect(stored[8]).toBe(0x11);
  expect(stored[PAGE * 2 - 50]).toBe(0x22);
  expect(stored[stored.length - 1]).toBe(0x22);
});

test("a competing write between stage and retry costs nothing, and a second committer follows", async () => {
  const rig = createRig(3, cleanups);
  await target(rig, 4);
  const first = await unattachedClient(rig, "target", cleanups);
  const second = await unattachedClient(rig, "target", cleanups);
  const rival = await attachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const node = first.node;
  const mine = new Uint8Array(PAGE).fill(0x22);
  const theirs = new Uint8Array(10).fill(0x44);
  await stage(first.fs, node, mine, PAGE);
  await stage(second.fs, node, theirs, 0);
  const before = owner.revision(node)!;
  // A competing attached write lands on the same pages after the stage was prepared.
  expect(rival.fs.tryWrite(node, [new Uint8Array(PAGE * 2).fill(0x33)], PAGE / 2)).toBe(PAGE * 2);
  expect(owner.revision(node)).toBe(before + 1);
  // The stage is only "these bytes at this place", so it is not stale: one call commits it.
  expect(first.fs.tryWrite(node, [mine], PAGE)).toBe(PAGE);
  expect(owner.revision(node)).toBe(before + 2);
  // The second committer finds the file waiting for the owner. Nothing of its write commits,
  // its call returns at once, and it is ready again after one owner turn.
  expect(withoutWaiting(() => second.fs.tryWrite(node, [theirs], 0))).toBe(-6);
  expect(owner.revision(node)).toBe(before + 2);
  await untilReady(second.fs, node, true);
  expect(second.fs.tryWrite(node, [theirs], 0)).toBe(10);
  expect(owner.revision(node)).toBe(before + 3);
  const stored = await readFile(rig, "/target");
  const expected = new Uint8Array(PAGE * 4).fill(0x11);
  expected.fill(0x33, PAGE / 2, PAGE / 2 + PAGE * 2);
  expected.fill(0x22, PAGE, PAGE * 2);
  expected.fill(0x44, 0, 10);
  expect(stored.every((byte, index) => byte === expected[index])).toBe(true);
});

test("a staged append commits at the moved end, once, and reports its true end offset", async () => {
  const rig = createRig(3, cleanups);
  await target(rig, 1, 2);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const rival = await attachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const tail = new Uint8Array(100).fill(0x46);
  expect(withoutWaiting(() => fs.tryAppend(node, [tail]))).toBe(-6);
  await untilReady(fs, node, true);
  expect(owner.stat(node)!.size).toBe(PAGE);
  // A competing attached append takes the old end before the retry.
  expect(rival.fs.tryAppend(node, [new Uint8Array(50).fill(0x47)])).toEqual({
    written: 50,
    offset: PAGE + 50,
  });
  const appended = withoutWaiting(() => fs.tryAppend(node, [tail]));
  expect(appended).toEqual({ written: 100, offset: PAGE + 150 });
  const stored = await readFile(rig, "/target");
  expect(stored).toHaveLength(PAGE + 150);
  expect(stored.subarray(PAGE, PAGE + 50).every((byte) => byte === 0x47)).toBe(true);
  expect(stored.subarray(PAGE + 50).every((byte) => byte === 0x46)).toBe(true);
  expect(stored.filter((byte) => byte === 0x46)).toHaveLength(100);
});

test("a retry with other bytes, another offset or another kind prepares again", async () => {
  const rig = createRig(3, cleanups);
  await target(rig, 4);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  await stage(fs, node, new Uint8Array(PAGE).fill(0x44), 0);
  // Preparation kept no iovec, so only the bytes the retry carries may ever commit.
  const changed = new Uint8Array(PAGE).fill(0x45);
  expect(withoutWaiting(() => fs.tryWrite(node, [changed], 0))).toBe(-6);
  expect(owner.revision(node)).toBe(before);
  await untilReady(fs, node, true);
  expect(withoutWaiting(() => fs.tryWrite(node, [changed], PAGE))).toBe(-6);
  expect(owner.revision(node)).toBe(before);
  await untilReady(fs, node, true);
  expect(withoutWaiting(() => fs.tryAppend(node, [changed]))).toBe(-6);
  expect(owner.revision(node)).toBe(before);
  await untilReady(fs, node, true);
  expect(fs.tryAppend(node, [changed])).toEqual({ written: PAGE, offset: PAGE * 5 });
  expect(owner.revision(node)).toBe(before + 1);
  const stored = await readFile(rig, "/target");
  expect(stored).toHaveLength(PAGE * 5);
  expect(stored.subarray(0, PAGE * 4).every((byte) => byte === 0x11)).toBe(true);
  expect(stored.subarray(PAGE * 4).every((byte) => byte === 0x45)).toBe(true);
});

test("a long immediate write commits a reported prefix, and short forms keep their results", async () => {
  const rig = createRig(3, cleanups);
  await target(rig, 64);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const large = [new Uint8Array(100 * 1024).fill(0x61), new Uint8Array(100 * 1024).fill(0x62)];
  expect(fs.tryWrite(node, large, 0)).toBe(-6);
  await untilReady(fs, node, true);
  expect(fs.tryWrite(node, large, 0)).toBe(64 * 1024);
  const stored = await readFile(rig, "/target");
  expect(stored[65535]).toBe(0x61);
  expect(stored[65536]).toBe(0x11);
  // An empty write and an empty append need no backing and stage nothing.
  const before = owner.revision(node)!;
  expect(fs.tryWrite(node, [new Uint8Array()], 5)).toBe(0);
  expect(fs.tryAppend(node, [])).toEqual({ written: 0, offset: PAGE * 64 });
  expect(fs.completions.size).toBe(0);
  expect(owner.revision(node)).toBe(before);
  // A read at the end of the file is zero bytes, and asks for no segment either.
  const untouched = new Uint8Array(4).fill(5);
  expect(fs.tryRead(node, [untouched], PAGE * 64)).toBe(0);
  expect(fs.tryRead(node, [new Uint8Array()], 0)).toBe(0);
  expect(untouched).toEqual(new Uint8Array(4).fill(5));
  expect(fs.completions.size).toBe(0);
});

test("cancelling before or after readiness leaves no effect and holds nothing", async () => {
  const rig = createRig(3, cleanups);
  await target(rig);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  const used = owner.resources().usedBytes;
  const bytes = new Uint8Array(PAGE).fill(0x33);
  // After readiness: closing the handle withdraws the finished stage.
  await stage(fs, node, bytes, 0);
  const retained = requestBudgetBytes(rig.identity.requestBudget) - PAGE;
  fs.release(node);
  await settle();
  expect(owner.revision(node)).toBe(before);
  expect(requestBudgetBytes(rig.identity.requestBudget)).toBe(retained);
  // Before readiness: the owner is still held when the handle closes.
  fs.retain(node);
  const hold = holdOwner(rig.service, ["stageWrite"]);
  expect(fs.tryWrite(node, [bytes], 0)).toBe(-6);
  await hold.entered;
  fs.release(node);
  hold.release();
  await settle();
  expect(owner.revision(node)).toBe(before);
  expect(owner.resources().usedBytes).toBe(used);
  expect(requestBudgetBytes(rig.identity.requestBudget)).toBe(retained);
  expect((await readFile(rig, "/target")).every((byte) => byte === 0x11)).toBe(true);
  // A fresh write on the same handle still works.
  fs.retain(node);
  await stage(fs, node, bytes, 0);
  expect(fs.tryWrite(node, [bytes], 0)).toBe(PAGE);
  expect((await readFile(rig, "/target"))[0]).toBe(0x33);
});

test("a revoked client cannot commit a finished stage", async () => {
  const rig = createRig(3, cleanups);
  await target(rig);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  const bytes = new Uint8Array(PAGE).fill(0x35);
  await stage(fs, node, bytes, 0);
  revokeFilesystem(fs.connection);
  expect(fs.tryWrite(node, [bytes], 0)).toBe(-11);
  await settle();
  expect(owner.revision(node)).toBe(before);
  expect((await readFile(rig, "/target"))[0]).toBe(0x11);
});

test("a full tree with zero free pages still commits an overwrite of an unattached segment", async () => {
  const rig = createRig(2, cleanups);
  await fillFirstSegment(rig);
  // Every page of segment 1 belongs to the target. Its size stops one page short of its
  // capacity, so an append of up to a page fits without growth too.
  const size = SHARED_SEGMENT_BYTES - PAGE;
  await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(size).fill(0x11));
  const owner = rig.backend.shared;
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  await rig.client.asyncCall("grow", [
    await resolveNode(rig.client, "target"),
    SHARED_SEGMENT_BYTES,
  ]);
  await settle();
  expect(owner.resources()).toMatchObject({
    usedBytes: SHARED_SEGMENT_BYTES * 2,
    freeBytes: 0,
    maxBytes: SHARED_SEGMENT_BYTES * 2,
  });
  const rival = await attachedClient(rig, "target", cleanups);
  const before = owner.revision(node)!;
  const at = PAGE * 5 + 50;
  const bytes = new Uint8Array(PAGE * 3 + 100).fill(0x22);
  await stage(fs, node, bytes, at);
  expect(owner.resources().freeBytes).toBe(0);
  // A competing attached write and a competing append land before the retry.
  expect(rival.fs.tryWrite(node, [new Uint8Array(PAGE * 2).fill(0x33)], at - PAGE)).toBe(PAGE * 2);
  expect(rival.fs.tryAppend(node, [new Uint8Array(100).fill(0x66)])).toEqual({
    written: 100,
    offset: size + 100,
  });
  expect(withoutWaiting(() => fs.tryWrite(node, [bytes], at))).toBe(bytes.length);
  expect(owner.revision(node)).toBe(before + 3);
  expect(fs.shared.segments).toHaveLength(1);
  // The staged append commits after the competing one, at the true end, up to the cap.
  const tail = new Uint8Array(1000).fill(0x55);
  expect(fs.tryAppend(node, [tail])).toBe(-6);
  await untilReady(fs, node, true);
  expect(fs.tryAppend(node, [tail])).toEqual({ written: 1000, offset: size + 1100 });
  const stored = await readFile(rig, "/target");
  expect(stored).toHaveLength(size + 1100);
  const expected = new Uint8Array(size + 1100).fill(0x11);
  expected.fill(0x33, at - PAGE, at + PAGE);
  expected.fill(0x22, at, at + bytes.length);
  expected.fill(0x66, size, size + 100);
  expected.fill(0x55, size + 100);
  expect(stored.every((byte, index) => byte === expected[index])).toBe(true);
  expect(owner.resources()).toMatchObject({ usedBytes: SHARED_SEGMENT_BYTES * 2, freeBytes: 0 });
  // Growth past the cap is refused exactly where an attached write is refused.
  const beyond = new Uint8Array(PAGE * 2).fill(0x77);
  expect(fs.tryAppend(node, [beyond])).toBe(-6);
  await untilReady(fs, node, true);
  expect(fs.tryAppend(node, [beyond])).toBe(-51);
  expect(rival.fs.tryAppend(node, [beyond])).toBe(-6);
  await untilReady(rival.fs, node, true);
  expect(rival.fs.tryAppend(node, [beyond])).toBe(-51);
  expect((await readFile(rig, "/target")).length).toBe(size + 1100);
});

test("a committed write survives a lost discard: retirement applies it", async () => {
  const rig = createRig(3, cleanups);
  await target(rig);
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const reader = await attachedClient(rig, "target", cleanups);
  const bytes = new Uint8Array(PAGE).fill(0x52);
  await stage(fs, node, bytes, 0);
  const retained = requestBudgetBytes(rig.identity.requestBudget) - PAGE;
  // The port closes with the discard still unsent, as when an agent dies right after commit.
  fs.connection.port.postMessage = () => {};
  expect(fs.tryWrite(node, [bytes], 0)).toBe(PAGE);
  await settle();
  // No owner operation has touched the file, and no discard arrived: it still waits.
  expect(awaitsOwner(reader)).toBe(true);
  reapFilesystem(fs.connection);
  rig.service.sweep();
  expect(awaitsOwner(reader)).toBe(false);
  expect(directBytes(reader, 0, PAGE)).toEqual({ count: PAGE, bytes });
  expect(requestBudgetBytes(rig.identity.requestBudget)).toBe(retained);
});

test("an interrupted commit is settled without resetting counts or reusing its arena", async () => {
  const rig = createRig(3, cleanups);
  await target(rig, 4);
  const owner = rig.backend.shared;
  const slot = owner.fileSlot((await unattachedClient(rig, "target", cleanups)).node);
  const reader = await attachedClient(rig, "target", cleanups);
  const interrupted = async (
    offset: number,
    fill: number,
    boundary: (cells: Int32Array, fs: FilesystemClient) => void,
  ) => {
    const { fs, node } = await unattachedClient(rig, "target", cleanups);
    const bytes = new Uint8Array(PAGE).fill(fill);
    await stage(fs, node, bytes, offset);
    const internals = fs as unknown as {
      stagedWrites: Map<number, { completion: { cells: Int32Array } }>;
      section: { enter(): void; exit(): void };
    };
    // The agent dies inside its counted section, mid-commit.
    internals.section.enter();
    boundary(internals.stagedWrites.get(node)!.completion.cells, fs);
    fs.connection.port.postMessage = () => {};
    reapFilesystem(fs.connection);
    rig.service.sweep();
    return { fs, node, bytes, section: internals.section };
  };
  const before = owner.revision(reader.node)!;
  // Never reached its commit point: the owner withdraws the stage and nothing changed.
  const never = await interrupted(0, 0x71, () => {});
  expect(directBytes(reader, 0, PAGE).bytes.every((byte) => byte === 0x11)).toBe(true);
  expect(owner.revision(reader.node)).toBe(before);
  // Died right after the commit point, before it closed the gate or moved the revision.
  const early = await interrupted(PAGE, 0x72, (cells) => {
    Atomics.store(cells, 1, PAGE);
    Atomics.compareExchange(cells, 0, State.Complete, State.Committed);
  });
  expect(directBytes(reader, PAGE, PAGE)).toEqual({ count: PAGE, bytes: early.bytes });
  expect(owner.revision(reader.node)).toBe(before + 1);
  // Died after it closed the gate.
  const late = await interrupted(PAGE * 2, 0x73, (cells) => {
    Atomics.store(cells, 1, PAGE * 2);
    Atomics.compareExchange(cells, 0, State.Complete, State.Committed);
    owner.slots[slot * SLOT_WORDS + 10]!++;
    owner.slots[slot * SLOT_WORDS + REVISION_STATE]! &= ~1;
  });
  expect(directBytes(reader, PAGE * 2, PAGE)).toEqual({ count: PAGE, bytes: late.bytes });
  expect(owner.revision(reader.node)).toBe(before + 2);
  expect(owner.isResident(reader.node)).toBe(true);
  for (const dead of [never, early, late]) {
    // A reap is an ownership decision. It does not show that the agent left its section, so the
    // count stays as the agent left it and its request arena is not handed to a successor.
    expect(new Int32Array(dead.fs.connection.sections)[0]).toBe(1);
    expect(requestMemorySections(dead.fs.connection.requests)).toBe(1);
  }
  const arenas = [never, early, late].map((dead) => dead.fs.connection.requests.data);
  const successor = rig.client.fork();
  expect(arenas).not.toContain(successor.requests.data);
  // Only an observed zero frees an arena.
  never.section.exit();
  expect(requestMemorySections(never.fs.connection.requests)).toBe(0);
  const next = rig.client.fork();
  expect(next.requests.data).toBe(arenas[0]!);
  for (const connection of [successor, next]) {
    reapFilesystem(connection);
    connection.port.close();
  }
  rig.service.sweep();
});

test("a late or repeated settle of an old stage cannot touch a newer stage, newer bytes or a reused file", () => {
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 2);
  const owner = new SharedFilesystemState(identity.shared, identity.maxBytes);
  owner.register(1, file(1, SHARED_SEGMENT_BYTES), new Uint8Array(SHARED_SEGMENT_BYTES));
  owner.register(2, file(2, PAGE * 4), new Uint8Array(PAGE * 4).fill(0x11));
  const [built] = owner.takeNewSegments();
  const clientX = new SharedFilesystemState(identity.shared, identity.maxBytes, 7);
  const clientY = new SharedFilesystemState(identity.shared, identity.maxBytes, 9);
  const peer = new SharedFilesystemState(identity.shared, identity.maxBytes, 11);
  peer.addSegment(built!.buffer, built!.index);
  const epoch = new Int32Array(new SharedArrayBuffer(4));
  const live = () => false;
  const slot = owner.fileSlot(2);
  const prepared = () => {
    const cells = new Int32Array(new SharedArrayBuffer(32));
    cells[0] = State.Complete;
    return cells;
  };
  const read = (offset: number) => {
    const out = new Uint8Array(1);
    peer.directRead(slot, 2, [out], offset, live, 11, true);
    return out[0];
  };
  const gated = () => {
    try {
      read(0);
      return false;
    } catch (error) {
      return error instanceof MissingDataError;
    }
  };
  // The old stage: committed by X, then applied when the owner next touches the file.
  const oldBytes = new Uint8Array(PAGE).fill(0x21);
  const oldCells = prepared();
  const oldStage = owner.stageWrite(2, 0, false, oldBytes.slice(), oldCells);
  expect(clientX.commitStagedWrite(slot, 2, oldCells, oldBytes, false, 0, epoch, live, 7)).toBe(
    PAGE,
  );
  expect(gated()).toBe(true);
  expect(owner.snapshot(2)!.data[0]).toBe(0x21);
  expect(gated()).toBe(false);
  // The newer stage: committed by Y. Its gate is closed and its bytes are not applied yet.
  const newBytes = new Uint8Array(PAGE).fill(0x32);
  const newCells = prepared();
  const newStage = owner.stageWrite(2, PAGE, false, newBytes.slice(), newCells);
  expect(clientY.commitStagedWrite(slot, 2, newCells, newBytes, false, PAGE, epoch, live, 9)).toBe(
    PAGE * 2,
  );
  expect(gated()).toBe(true);
  const revision = owner.revision(2);
  // The old stage's discard arrives only now, and then again.
  owner.settleStagedWrite(oldStage);
  owner.settleStagedWrite(oldStage);
  expect(gated()).toBe(true);
  expect(Atomics.load(newCells, 0)).toBe(State.Committed);
  expect(Atomics.load(oldCells, 0)).toBe(State.Committed);
  owner.settleStagedWrite(newStage);
  expect(gated()).toBe(false);
  expect([read(0), read(PAGE), read(PAGE * 2)]).toEqual([0x21, 0x32, 0x11]);
  // Newer content, then both stages settle late again. Neither replays its bytes, even if its
  // request block was reused and happens to read as a committed stage at another position.
  const newer = new Uint8Array(PAGE * 2).fill(0x43);
  expect(peer.directWrite(slot, 2, [newer], 0, PAGE * 2, epoch, live, 11, true)).toBe(PAGE * 2);
  for (const cells of [oldCells, newCells]) {
    Atomics.store(cells, 0, State.Committed);
    Atomics.store(cells, 1, PAGE * 2);
  }
  owner.settleStagedWrite(oldStage);
  owner.settleStagedWrite(newStage);
  expect(gated()).toBe(false);
  expect([read(0), read(PAGE), read(PAGE * 2)]).toEqual([0x43, 0x43, 0x11]);
  expect(
    owner
      .snapshot(2)!
      .data.subarray(PAGE * 2)
      .every((byte) => byte === 0x11),
  ).toBe(true);
  expect(owner.revision(2)).toBe(revision! + 1);
  // A stage that outlives its file: the slot is reused by another file before it settles.
  const staleCells = prepared();
  const staleStage = owner.stageWrite(2, 0, false, new Uint8Array(PAGE).fill(0x5a), staleCells);
  owner.unlink(2);
  expect(owner.hasFile(2)).toBe(false);
  const reused = 2 + MAX_FILES - 1;
  owner.register(reused, file(3, PAGE), new Uint8Array(PAGE).fill(0x66));
  expect(owner.fileSlot(reused)).toBe(slot);
  const reusedRevision = owner.revision(reused);
  Atomics.store(staleCells, 1, 0);
  Atomics.store(staleCells, 0, State.Committed);
  owner.settleStagedWrite(staleStage);
  owner.settleStagedWrite(staleStage);
  expect(owner.snapshot(reused)!.data.every((byte) => byte === 0x66)).toBe(true);
  expect(owner.revision(reused)).toBe(reusedRevision);
  expect(owner.isResident(reused)).toBe(true);
});

/** The page's command stdio over one file, on a connection that lacks the file's segment. */
async function commandStdio(rig: Rig, node: number) {
  const descriptors = new DescriptorTable();
  cleanups.push(() => descriptors.dispose());
  const rights = (1n << 29n) - 1n;
  const input = descriptors.open(
    { kind: "file", handle: node, offset: 0, append: false },
    rights,
    0n,
  );
  const output = descriptors.open(
    { kind: "file", handle: node, offset: 0, append: false },
    rights,
    0n,
  );
  descriptors.inherit(0, descriptors.get(input)!);
  descriptors.inherit(1, descriptors.get(output)!);
  const abort = new AbortController();
  const stdio = new CommandStdio(descriptors, abort.signal, unattachedConnection(rig));
  const fs = (stdio as unknown as { filesystem: FilesystemClient }).filesystem;
  fs.retain(await resolveNode(fs, "target"));
  return { stdio, abort, fs };
}

test("the page's command stdio completes an unattached write and read while its event loop stays live", async () => {
  const rig = createRig(3, cleanups);
  const node = await target(rig);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  const { stdio, fs } = await commandStdio(rig, node);
  const hold = holdOwner(rig.service, ["stageWrite"]);
  let finished = false;
  // The page cannot block. Its write awaits readiness on the shared signal instead.
  const write = withoutWaiting(() => stdio.stdout.write(new Uint8Array(PAGE).fill(0x72))).then(
    () => {
      finished = true;
    },
  );
  await hold.entered;
  await settle();
  expect(finished).toBe(false);
  expect(owner.revision(node)).toBe(before);
  hold.release();
  await write;
  expect(owner.revision(node)).toBe(before + 1);
  expect(fs.shared.segments).toHaveLength(1);
  // Reading back through stdin goes through the owner too, after the write was applied.
  const read = await stdio.stdin.read();
  expect(read).toHaveLength(PAGE * 2);
  expect(read!.subarray(0, PAGE).every((byte) => byte === 0x72)).toBe(true);
  expect(read!.subarray(PAGE).every((byte) => byte === 0x11)).toBe(true);
  await stdio.settle();
  expect((await readFile(rig, "/target"))[0]).toBe(0x72);
});

test("aborting the page's command stdio rejects a staged write and leaves no effect", async () => {
  const rig = createRig(3, cleanups);
  const node = await target(rig);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  // Abort while the owner still holds the preparation.
  const early = await commandStdio(rig, node);
  const hold = holdOwner(rig.service, ["stageWrite"]);
  const cancelled = early.stdio.stdout
    .write(new Uint8Array(PAGE).fill(0x73))
    .catch((error: { code?: string }) => error.code);
  await hold.entered;
  early.abort.abort();
  expect(await cancelled).toBe("CANCELED");
  hold.release();
  await early.stdio.settle();
  await settle();
  expect(owner.revision(node)).toBe(before);
  // Abort after the preparation finished, before any retry could commit it.
  const late = await commandStdio(rig, node);
  expect(late.fs.tryWrite(node, [new Uint8Array(PAGE).fill(0x74)], 0)).toBe(-6);
  await untilReady(late.fs, node, true);
  late.abort.abort();
  expect(
    await late.stdio.stdout.write(new Uint8Array(PAGE).fill(0x74)).catch((error) => error.code),
  ).toBe("CANCELED");
  await late.stdio.settle();
  await settle();
  expect(owner.revision(node)).toBe(before);
  expect((await readFile(rig, "/target")).every((byte) => byte === 0x11)).toBe(true);
  expect(owner.isResident(node)).toBe(true);
});

test("a staged write publishes exactly once, and reader-pinned pages are relocated by the owner", async () => {
  const rig = createRig(3, cleanups, { publication: { workspace: true } });
  const node = await target(rig, 4);
  const owner = rig.backend.shared;
  const domain = owner.publication!;
  const { fs } = await unattachedClient(rig, "target", cleanups);
  const published = () => {
    const page = domain.changes(cut, domain.limits.logBytes);
    if (page.kind !== "changes") throw new Error(page.kind);
    return page.publications.flatMap((entry) => entry.changes);
  };
  let cut = domain.cut();
  const first = new Uint8Array(PAGE).fill(0x81);
  expect(withoutWaiting(() => fs.tryWrite(node, [first], 0))).toBe(-6);
  await untilReady(fs, node, true);
  // Preparation published nothing and left the admission open for no one.
  expect(domain.cut().generation).toBe(cut.generation);
  expect(withoutWaiting(() => fs.tryWrite(node, [first], 0))).toBe(PAGE);
  expect(domain.cut().generation).toBe(cut.generation + 1);
  const effects = published();
  expect(effects.map((effect) => effect.kind)).toEqual(["bytes", "metadata"]);
  expect(effects[0]).toMatchObject({ kind: "bytes", offset: 0, size: PAGE * 4, bytes: first });
  await settle();
  expect(domain.cut().generation).toBe(cut.generation + 1);
  expect((await readFile(rig, "/target"))[0]).toBe(0x81);
  // A reader holds the second page. The owner copies it aside while it prepares the stage, so
  // the commit never writes under the reader, and the pinned version stays readable.
  const pinned = owner.retainVersionPages(node, PAGE, PAGE);
  cut = domain.cut();
  const second = new Uint8Array(PAGE).fill(0x82);
  expect(fs.tryWrite(node, [second], PAGE)).toBe(-6);
  await untilReady(fs, node, true);
  expect(fs.tryWrite(node, [second], PAGE)).toBe(PAGE);
  expect(pinned.read(PAGE, 4)).toEqual(new Uint8Array(4).fill(0x11));
  // A pin that arrives between the preparation and the retry sends the write back once.
  const third = new Uint8Array(PAGE).fill(0x83);
  expect(fs.tryWrite(node, [third], PAGE * 2)).toBe(-6);
  await untilReady(fs, node, true);
  const late = owner.retainVersionPages(node, PAGE * 2, PAGE);
  const generation = domain.cut().generation;
  expect(withoutWaiting(() => fs.tryWrite(node, [third], PAGE * 2))).toBe(-6);
  expect(domain.cut().generation).toBe(generation);
  await untilReady(fs, node, true);
  expect(fs.tryWrite(node, [third], PAGE * 2)).toBe(PAGE);
  expect(late.read(PAGE * 2, 4)).toEqual(new Uint8Array(4).fill(0x11));
  expect(published().filter((effect) => effect.kind === "bytes")).toHaveLength(2);
  const stored = await readFile(rig, "/target");
  expect([stored[0], stored[PAGE], stored[PAGE * 2], stored[PAGE * 3]]).toEqual([
    0x81, 0x82, 0x83, 0x11,
  ]);
  const used = owner.resources().usedBytes;
  pinned.release();
  late.release();
  expect(owner.resources().usedBytes).toBe(used - PAGE * 2);
});

test("dirty admission refuses a commit with EAGAIN and keeps the stage for the retry", async () => {
  const rig = createRig(3, cleanups);
  const node = await target(rig);
  const { fs } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  const bytes = new Uint8Array(PAGE).fill(0x91);
  await stage(fs, node, bytes, 0);
  const admission = fs.shared.dirtyAdmission;
  const checkFile = admission.checkFile;
  let refusals = 0;
  admission.checkFile = () => {
    refusals++;
    throw new DirtyCapacityError();
  };
  const outstanding = fs.completions.size;
  try {
    expect(withoutWaiting(() => fs.tryWrite(node, [bytes], 0))).toBe(-6);
  } finally {
    admission.checkFile = checkFile;
  }
  // Refused before the commit point: nothing changed and nothing new was submitted.
  expect(refusals).toBe(1);
  expect(fs.completions.size).toBe(outstanding);
  expect(owner.revision(node)).toBe(before);
  expect(awaitsOwner({ fs: rig.client, node })).toBe(false);
  expect(withoutWaiting(() => fs.tryWrite(node, [bytes], 0))).toBe(PAGE);
  expect(owner.revision(node)).toBe(before + 1);
  expect((await readFile(rig, "/target"))[0]).toBe(0x91);
});

test("a stage the owner cannot prepare fails once with its errno and changes nothing", async () => {
  const rig = createRig(3, cleanups);
  const node = await target(rig);
  const { fs } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared;
  const before = owner.revision(node)!;
  // The write needs growth into segment 2, and the platform refuses that construction.
  const internals = owner as unknown as { ensureSegment(segment: number): void };
  const ensure = internals.ensureSegment;
  internals.ensureSegment = function (this: typeof owner, segment: number) {
    if (segment === 2) throw new RangeError("injected segment refusal");
    return Reflect.apply(ensure, this, [segment]);
  };
  const used = owner.resources().usedBytes;
  const bytes = new Uint8Array(PAGE).fill(0x95);
  const at = SHARED_SEGMENT_BYTES;
  let result = -6;
  for (let attempt = 0; attempt < 6 && result === -6; attempt++) {
    result = fs.tryWrite(node, [bytes], at);
    if (result === -6) await untilReady(fs, node, true);
  }
  internals.ensureSegment = ensure;
  expect(result).toBe(-51);
  expect(owner.revision(node)).toBe(before);
  expect(owner.resources().usedBytes).toBe(used);
  expect(2 in owner.segments).toBe(false);
  expect(fs.completions.size).toBe(0);
  expect(await readFile(rig, "/target")).toHaveLength(PAGE * 2);
});

class Store implements StorageBackend {
  private identityReservation?: StoredReservation;
  index?: PersistedIndex;
  payloads = new Map<string, Uint8Array>();
  readRange = fixturePayloadHooks(this.payloads).readRange;
  retainPayload = fixturePayloadHooks(this.payloads).retainPayload;
  async reserveIdentity(workspace?: string) {
    const value = nextReservation(this.identityReservation, workspace);
    this.identityReservation = storeReservation(value);
    return value;
  }
  async load() {
    return this.index;
  }
  async read(key: string) {
    return this.payloads.get(key)!.slice();
  }
  async persist(batch: PersistenceBatch) {
    const nodes = new Map(this.index?.nodes.map((entry) => [entry.ino, entry]));
    for (const entry of batch.upserts) nodes.set(entry.ino, entry);
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, data] of batch.data) this.payloads.set(key, data.slice());
    this.index = {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush() {}
  async close() {}
}
/** Polls and retries an immediate write the way a guest does, and counts its EAGAIN returns. */
async function immediateWrite(fs: FilesystemClient, node: number, bytes: Uint8Array, at: number) {
  for (let again = 0; again < 8; again++) {
    const result = withoutWaiting(() => fs.tryWrite(node, [bytes], at));
    if (result !== -6) return { result, again };
    await untilReady(fs, node, true);
  }
  throw new Error("immediate write never completed");
}

test("a persistent tree persists a committed staged write and stages onto a cold file", async () => {
  const store = new Store();
  const backend = await PersistentBackend.open(store, { intervalMs: 0, dirtyLimits: false });
  cleanups.push(async () => {
    await backend.close();
    backend.dispose();
  });
  const rig = createRig(3, cleanups, { backend });
  const node = await target(rig);
  const { fs } = await unattachedClient(rig, "target", cleanups);
  const first = new Uint8Array(PAGE).fill(0x61);
  await stage(fs, node, first, 0);
  // The discard never arrives. Only an owner operation can apply the committed write now, and
  // the checkpoint's snapshot is one: it must persist the new bytes, not the gated old ones.
  fs.connection.port.postMessage = () => {};
  expect(fs.tryWrite(node, [first], 0)).toBe(PAGE);
  await rig.client.asyncCall("flush");
  const persisted = Array.from(store.payloads.values()).filter(
    (payload) => payload.length === PAGE * 2,
  );
  expect(persisted.map((payload) => [payload[0], payload[PAGE]])).toContainEqual([0x61, 0x11]);
  expect(backend.shared.isResident(node)).toBe(true);
  // Reopen the tree: every file is cold. Loading the full file takes segment 0, so the target
  // is hydrated into a segment the next client lacks.
  const reopened = await PersistentBackend.open(store, { intervalMs: 0, dirtyLimits: false });
  cleanups.push(async () => {
    await reopened.close();
    reopened.dispose();
  });
  const cold = createRig(3, cleanups, { backend: reopened });
  expect((await readFile(cold, "/full")).length).toBe(SHARED_SEGMENT_BYTES);
  const guest = await unattachedClient(cold, "target", cleanups);
  expect(reopened.shared.isResident(guest.node)).toBe(false);
  // Hydration first, then the stage, then the commit. No call waits, and nothing is written
  // behind an EAGAIN.
  const second = new Uint8Array(PAGE).fill(0x62);
  const outcome = await immediateWrite(guest.fs, guest.node, second, PAGE);
  expect(outcome).toEqual({ result: PAGE, again: 2 });
  expect(guest.fs.shared.segments).toHaveLength(1);
  const stored = await readFile(cold, "/target");
  expect(stored).toHaveLength(PAGE * 2);
  expect(stored.subarray(0, PAGE).every((byte) => byte === 0x61)).toBe(true);
  expect(stored.subarray(PAGE).every((byte) => byte === 0x62)).toBe(true);
});
