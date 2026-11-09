import { afterEach, expect, test } from "bun:test";
import {
  FilesystemClient,
  reapFilesystem,
  revokeFilesystem,
  type FilesystemConnection,
} from "../fs";
import { createFilesystemIdentity } from "../fs/protocol";
import {
  FilesystemRequestAllocator,
  FilesystemRequestPool,
  FilesystemTransportSection,
  createRequestBudget,
  requestBytes,
  requestMemorySections,
  retireRequestMemory,
} from "../fs/request-memory";
import { TOTAL_DATA_PAGES } from "../fs/storage-geometry";
import type { GuestMode } from "./fixtures/lazy-backing-guest.js";
import {
  DATA_PAGE_BYTES as PAGE,
  SHARED_SEGMENT_BYTES,
  createRig,
  fillFirstSegment,
  holdOwner,
  readFile,
  resolveNode,
  sameBacking,
  settle,
  unattachedClient,
  untilReady,
  type Cleanup,
  type Rig,
} from "./fixtures/lazy-backing.js";

const cleanups: Cleanup[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const PROGRESS = 0;
const GATE = 1;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pattern = (index: number) => 200 + (index % 37);
function content(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = pattern(index);
  return bytes;
}
function openGate(cells: Int32Array): void {
  Atomics.store(cells, GATE, 1);
  Atomics.notify(cells, GATE);
}
async function progress(cells: Int32Array, value: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Atomics.load(cells, PROGRESS) !== value) {
    if (Date.now() > deadline) throw new Error(`guest never reached step ${value}`);
    await sleep(1);
  }
}
/** A real Worker on its own connection. `connection` is its launch snapshot. */
function startGuest(
  rig: Rig,
  mode: GuestMode,
  connection: FilesystemConnection,
  onPolling?: () => void,
) {
  const cells = new Int32Array(new SharedArrayBuffer(16));
  const guest = new Worker(new URL("./fixtures/lazy-backing-guest.ts", import.meta.url).href);
  const closed = new Promise<void>((resolve) => guest.addEventListener("close", () => resolve()));
  const result = new Promise<any>((resolve, reject) => {
    guest.onmessage = ({ data }) => {
      if (data.phase === "polling") onPolling?.();
      else resolve(data);
    };
    guest.onerror = (event) => reject(new Error(String(event.message)));
  });
  cleanups.push(async () => {
    openGate(cells);
    await Promise.race([closed, sleep(2_000)]);
    guest.terminate();
    reapFilesystem(connection);
    rig.service.sweep();
  });
  guest.postMessage({ connection, cells: cells.buffer, mode, path: "target" }, [connection.port]);
  return { guest, cells, connection, result };
}
/** A launch snapshot from before any extra segment existed. */
function oldSnapshot(rig: Rig): FilesystemConnection {
  const connection = rig.client.fork();
  connection.segments = [];
  return connection;
}

test("an empty identity constructs no growable buffer and no data segment", async () => {
  const worker = new Worker(
    new URL("./fixtures/lazy-backing-constructions.ts", import.meta.url).href,
  );
  cleanups.push(() => worker.terminate());
  const reply = await new Promise<any>((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (event) => reject(new Error(String(event.message)));
    worker.postMessage("observe");
  });
  expect(reply.error).toBeUndefined();
  const value = reply.value;
  expect(value.imported).toEqual([]);
  // The advertised cap is whole, and nothing was built for it. The exact list matters: a
  // placeholder of any length, even one byte or a header's worth, would appear here.
  expect(value.maxBytes).toBe(1_610_612_736);
  expect(value.segments).toBe(0);
  expect(value.identityConstructions).toEqual([
    { bytes: 33_289_256, maximum: null },
    { bytes: 262_144, maximum: null },
    { bytes: 49_156, maximum: null },
    { bytes: 4, maximum: null },
    { bytes: 32, maximum: null },
    { bytes: 4, maximum: null },
    { bytes: 4, maximum: null },
    { bytes: 8, maximum: null },
  ]);
  // The request arena is the one growable buffer. It is the attached transport that serves
  // pages an agent lacks, it is declared at its full maximum, and it is not file backing.
  expect(value.connectionConstructions).toEqual([
    { bytes: 72, maximum: null },
    { bytes: 0, maximum: 134_316_032 },
  ]);
  expect(value.forkConstructions.every((entry: any) => entry.maximum === null)).toBe(true);
  expect(value.forkConstructions.reduce((sum: number, entry: any) => sum + entry.bytes, 0)).toBe(
    49_156 + 4 + 8,
  );
  // The owner plan holds no segment record.
  expect(value.plan.allocations).toBe(9 + value.arenaAllocations);
  expect(value.plan.references).toBe(value.plan.allocations);
  // At the full default cap the owner builds exactly the one segment the last page needs, as a
  // fixed buffer, and the next page is refused without constructing anything.
  expect(value.lastPageConstructions).toEqual([{ bytes: SHARED_SEGMENT_BYTES, maximum: null }]);
  expect(value.lastSegment).toEqual([95]);
  expect(value.pastCap).toBe(51);
  expect(value.pastCapConstructions).toEqual([]);
  // A native refusal of the second new segment of one request: the first stays and is announced
  // once, no file page is committed, and the same request then succeeds.
  expect(value.refused).toBe(51);
  expect(value.refusedConstructions).toEqual([{ bytes: SHARED_SEGMENT_BYTES, maximum: null }]);
  expect(value.afterRefusal).toEqual({ usedBytes: 0, built: [1], announced: [1], hasFile: false });
  expect(value.retried.constructions).toEqual([{ bytes: SHARED_SEGMENT_BYTES, maximum: null }]);
  expect(value.retried.announced).toEqual([2]);
  expect(TOTAL_DATA_PAGES * PAGE).toBe(1_610_612_736);
});

test("a guest blocked in its synchronous path reaches a segment built after it started", async () => {
  const rig = createRig(3, cleanups);
  await fillFirstSegment(rig);
  await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array());
  const { guest, cells, result } = startGuest(rig, "blocked-reader", rig.client.fork());
  await progress(cells, 1);
  expect(1 in rig.backend.shared.segments).toBe(false);
  guest.postMessage("canary");
  await rig.client.asyncCall("writeFile", ["/target"], content(220_000));
  expect(rig.backend.shared.segments[1]?.byteLength).toBe(SHARED_SEGMENT_BYTES);
  await settle();
  openGate(cells);
  const value = await result;
  expect(value.error).toBeUndefined();
  // No event-loop turn ran, so no buffer could reach the guest. It read and wrote anyway,
  // through the request arena that was attached before it started.
  expect(value).toMatchObject({
    phase: "done",
    attachedBefore: 1,
    attachedAfter: 1,
    turnsAfterWake: 0,
    turns: 0,
    firstCount: PAGE,
    firstValue: pattern(PAGE - 1),
    // A read larger than one transport page, into two iovecs, is complete.
    largeCount: 220_000,
    largeHead: pattern(99_999),
    largeRest: [pattern(100_000), pattern(219_999)],
    written: PAGE,
    appended: { written: 3, offset: 220_003 },
    reread: [0x5a, 0x5a, 0x5a, 0x5a],
  });
  expect(value.missing).toBeGreaterThan(0);
  expect(value.operations).toEqual(expect.arrayContaining(["read", "write", "append"]));
  const stored = await readFile(rig, "/target");
  expect(stored).toHaveLength(220_003);
  expect(stored.subarray(PAGE * 2, PAGE * 3).every((byte) => byte === 0x5a)).toBe(true);
  expect(stored[PAGE * 3]).toBe(pattern(PAGE * 3));
  expect(stored.subarray(220_000).every((byte) => byte === 0x5b)).toBe(true);
});

test("a revoked blocked reader gets no bytes, and a reaped one never reaches a successor tree", async () => {
  const rig = createRig(3, cleanups);
  await fillFirstSegment(rig);
  await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(PAGE).fill(0xa7));
  await settle();
  const revoked = startGuest(rig, "revoked-reader", oldSnapshot(rig));
  await progress(revoked.cells, 1);
  revokeFilesystem(revoked.connection);
  openGate(revoked.cells);
  expect(await revoked.result).toMatchObject({ revokedRead: -11, untouched: true, turns: 0 });
  // The second Worker stays alive and parked through revoke, reap and sweep. Those are owner
  // accounting. They do not show that the Worker stopped, and nothing here relies on that.
  const stale = startGuest(rig, "revoked-reader", oldSnapshot(rig));
  await progress(stale.cells, 1);
  revokeFilesystem(stale.connection);
  reapFilesystem(stale.connection);
  rig.service.sweep();
  await settle();
  await rig.client.asyncCall("writeFile", ["/after-reap"], new Uint8Array(PAGE).fill(0x3c));
  const successor = createRig(3, cleanups);
  await fillFirstSegment(successor);
  await successor.client.asyncCall("writeFile", ["/next"], new Uint8Array(PAGE).fill(0x4d));
  const old = rig.backend.shared.segments[1];
  const next = successor.backend.shared.segments[1];
  // Segments are never handed from one tree to another, so a wrapper the stale agent may still
  // hold can only name its own tree.
  expect(old).toBeInstanceOf(SharedArrayBuffer);
  expect(next).toBeInstanceOf(SharedArrayBuffer);
  expect(sameBacking(old, next)).toBe(false);
  openGate(stale.cells);
  expect(await stale.result).toMatchObject({ revokedRead: -11, untouched: true, turns: 0 });
});

for (const mode of ["abi-write", "abi-append"] as const) {
  test(`runtime_proc ${mode} to an unattached segment returns EAGAIN, polls, then commits`, async () => {
    const rig = createRig(3, cleanups);
    await fillFirstSegment(rig);
    await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(PAGE * 2).fill(0x11));
    const node = await resolveNode(rig.client, "target");
    await rig.client.asyncCall("grow", [node, PAGE * 4]);
    await settle();
    const owner = rig.backend.shared;
    const before = owner.revision(node)!;
    const hold = holdOwner(rig.service, ["stageWrite"]);
    const polling = Promise.withResolvers<void>();
    const { result } = startGuest(rig, mode, oldSnapshot(rig), polling.resolve);
    // The guest is inside poll while the owner is held. Its write returned without waiting, and
    // the ABI made no blocking filesystem call: the fixture turns any such call into a throw.
    await hold.entered;
    await polling.promise;
    expect(owner.revision(node)).toBe(before);
    hold.release();
    const value = await result;
    expect(value.error).toBeUndefined();
    const start = mode === "abi-append" ? PAGE * 2 : PAGE;
    expect(value).toMatchObject({
      phase: "done",
      first: -6,
      // EAGAIN did not move the descriptor offset.
      firstOffset: mode === "abi-append" ? 0 : PAGE,
      ready: 1,
      second: PAGE,
      offset: start + PAGE,
      attached: 1,
      turns: 0,
    });
    expect(value.waits).toBeGreaterThan(0);
    expect(owner.revision(node)).toBe(before + 1);
    const stored = await readFile(rig, "/target");
    expect(stored).toHaveLength(mode === "abi-append" ? PAGE * 3 : PAGE * 2);
    expect(stored.subarray(start, start + PAGE).every((byte) => byte === 0x71)).toBe(true);
    expect(stored.subarray(0, PAGE).every((byte) => byte === 0x11)).toBe(true);
  });
}

async function ownerRead(
  mode: GuestMode,
  interfere?: (rig: Rig, cells: Int32Array) => Promise<void>,
) {
  const rig = createRig(3, cleanups);
  await fillFirstSegment(rig);
  await rig.client.asyncCall("writeFile", ["/target"], content(220_000));
  await settle();
  const { cells, result } = startGuest(rig, mode, oldSnapshot(rig));
  await interfere?.(rig, cells);
  const value = await result;
  expect(value.error).toBeUndefined();
  expect(value).toMatchObject({ phase: "done", attached: 1, turns: 0 });
  return value;
}

test("a blocking owner read fills several iovecs past one transport page from one revision", async () => {
  const value = await ownerRead("owner-read");
  expect(value).toMatchObject({
    count: 220_000,
    reads: 4,
    first: [pattern(0), pattern(65_535), pattern(65_536), pattern(99_999)],
    second: [pattern(100_000), pattern(219_999)],
  });
});

test("a change after progress returns the delivered prefix, never mixed revisions", async () => {
  const value = await ownerRead("owner-read-shrink", async (rig, cells) => {
    await progress(cells, 2);
    await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(10).fill(9));
    openGate(cells);
  });
  // The second reply was taken across the change. It is dropped, and the first page stands.
  expect(value).toMatchObject({
    count: 65_536,
    reads: 2,
    first: [pattern(0), pattern(65_535), 1, 1],
    second: [2, 2],
  });
});

test("a change before any progress asks again and is never reported as end of file", async () => {
  const value = await ownerRead("owner-read-race", async (rig, cells) => {
    await progress(cells, 1);
    await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(70_000).fill(7));
    openGate(cells);
  });
  expect(value).toMatchObject({ count: 70_000, first: [7, 7, 7, 1], second: [2, 2] });
});

test("an owner read failure keeps a delivered prefix and reports an error before progress", async () => {
  expect(await ownerRead("owner-read-later-error")).toMatchObject({
    count: 65_536,
    first: [pattern(0), pattern(65_535), 1, 1],
    second: [2, 2],
  });
  expect(await ownerRead("owner-read-first-error")).toMatchObject({
    count: -29,
    first: [1, 1, 1, 1],
    second: [2, 2],
  });
});

test("an immediate read across an attached and an absent segment changes nothing behind EAGAIN", async () => {
  const rig = createRig(3, cleanups);
  await rig.client.asyncCall("writeFile", ["/full"], new Uint8Array(SHARED_SEGMENT_BYTES - PAGE));
  await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(PAGE * 2).fill(0x81));
  await settle();
  const { fs, node } = await unattachedClient(rig, "target", cleanups);
  const owner = rig.backend.shared as unknown as {
    pages: Int32Array;
    pageAt(slot: number, logical: number): number;
    fileSlot(handle: number): number;
  };
  const slot = owner.fileSlot(node);
  const physical = [0, 1].map((logical) => owner.pages[owner.pageAt(slot, logical)]! - 1);
  // The fixture really spans two segments: the first page is one this client holds.
  expect(physical[0]).toBeLessThan(4096);
  expect(physical[1]).toBeGreaterThanOrEqual(4096);
  const destination = new Uint8Array(PAGE * 2).fill(5);
  expect(fs.tryRead(node, [destination], 0)).toBe(-6);
  expect(destination.every((byte) => byte === 5)).toBe(true);
  await untilReady(fs, node, false);
  expect(fs.tryRead(node, [destination], 0)).toBe(PAGE * 2);
  expect(destination.every((byte) => byte === 0x81)).toBe(true);
  // A range that lies wholly in the attached part is direct, with no request.
  const outstanding = fs.completions.size;
  const head = new Uint8Array(PAGE).fill(5);
  expect(fs.tryRead(node, [head], 0)).toBe(PAGE);
  expect(head.every((byte) => byte === 0x81)).toBe(true);
  // The end of the file needs no backing: it is a zero read, not a wait.
  const tail = new Uint8Array(4).fill(5);
  expect(fs.tryRead(node, [tail], PAGE * 2)).toBe(0);
  expect(tail.every((byte) => byte === 5)).toBe(true);
  expect(fs.completions.size).toBe(outstanding);
});

test("sparse, repeated and late segment announcements keep their index through real ports", async () => {
  const rig = createRig(96, cleanups);
  await rig.client.asyncCall("writeFile", ["/last"], new Uint8Array());
  const lastPage = TOTAL_DATA_PAGES - 1;
  rig.backend.shared.owners.fill(1, 0, lastPage);
  // A client that connects while the growth request is still in flight gets the segment from
  // its connect snapshot, from the broadcast, or from both. Either way it holds it once.
  const growing = rig.client.asyncCall("writeFile", ["/last"], new Uint8Array(PAGE).fill(0x91));
  const during = new FilesystemClient(rig.client.fork());
  cleanups.push(() => during.dispose());
  await growing;
  await settle();
  const built = rig.backend.shared.segments[95];
  expect(rig.backend.shared.owners[lastPage]).not.toBe(0);
  expect(rig.backend.shared.segments.filter(Boolean)).toHaveLength(2);
  expect(built?.byteLength).toBe(SHARED_SEGMENT_BYTES);
  // Holes below index 95 are not capacity that went missing.
  for (const client of [rig.client, during]) {
    expect(sameBacking(client.shared.segments[95], built)).toBe(true);
    expect(client.shared.segments.filter(Boolean)).toHaveLength(2);
    expect(client.connection.segments).toHaveLength(95);
    expect(0 in client.connection.segments).toBe(false);
  }
  const node = await resolveNode(rig.client, "last");
  rig.client.retain(node);
  const direct = new Uint8Array(4);
  const outstanding = rig.client.completions.size;
  expect(rig.client.tryRead(node, [direct], PAGE - 4)).toBe(4);
  expect(direct).toEqual(new Uint8Array(4).fill(0x91));
  expect(rig.client.completions.size).toBe(outstanding);
  // An old snapshot that connects later is offered the existing segment at its index.
  const snapshot = oldSnapshot(rig);
  const late = new FilesystemClient(snapshot);
  cleanups.push(() => late.dispose());
  expect(late.shared.segments).toHaveLength(1);
  await settle();
  expect(sameBacking(late.shared.segments[95], built)).toBe(true);
  // A repeated delivery keeps the first accepted wrapper.
  const accepted = late.shared.segments[95];
  late.shared.addSegment(structuredClone(built!), 95);
  expect(late.shared.segments[95]).toBe(accepted!);
  // A fork made after attachment starts with the segment, and a clone keeps the holes.
  const fork = structuredClone({ segments: rig.client.fork().segments });
  expect(fork.segments).toHaveLength(95);
  expect(0 in fork.segments).toBe(false);
  expect(sameBacking(fork.segments[94], built)).toBe(true);
});

test("a retired request arena is reused only after its old publisher is seen to have left", () => {
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES);
  const pool = new FilesystemRequestPool(createRequestBudget(), 65_536);
  // The old client is admitted to its counted publication section and has a request block.
  const revocation = new SharedArrayBuffer(4);
  const old = pool.take(revocation);
  const section = new FilesystemTransportSection(identity, old, () => false);
  section.enter();
  const admitted = new FilesystemRequestAllocator(old).allocate(64);
  // The connection is reaped and its transport retired while that agent is still inside.
  Atomics.store(new Int32Array(revocation), 0, 2);
  retireRequestMemory(old);
  const successor = pool.take(new SharedArrayBuffer(4));
  expect(successor.data).not.toBe(old.data);
  const block = new FilesystemRequestAllocator(successor).allocate(64);
  requestBytes(block).fill(22);
  // The paused publisher resumes its inline copy. It cannot reach the successor's bytes.
  requestBytes(admitted).fill(88);
  expect(requestBytes(block)[0]).toBe(22);
  // The count is neither reset nor assumed zero, and the arena stays held under its charge.
  expect(requestMemorySections(old)).toBe(1);
  const another = pool.take(new SharedArrayBuffer(4));
  expect(another.data).not.toBe(old.data);
  // Only the publisher's own exit makes the count zero. That observed zero frees the arena.
  section.exit();
  expect(requestMemorySections(old)).toBe(0);
  const reused = pool.take(new SharedArrayBuffer(4));
  expect(reused.data).toBe(old.data);
  expect(new Uint8Array(reused.data).every((byte) => byte === 0)).toBe(true);
});
