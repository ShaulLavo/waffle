import { afterEach, expect, test } from "bun:test";
import {
  MissingSegmentError,
  SharedFilesystemState,
  connectFilesystemIdentity,
  createFilesystemIdentity,
  reapFilesystem,
} from "../fs";
import { SHARED_SEGMENT_BYTES } from "../fs/shared";
import { CONNECTION_SHARED_BYTES } from "../fs/protocol";
import {
  DATA_PAGE_BYTES as PAGE,
  DATA_PAGES_PER_SEGMENT,
  TOTAL_DATA_PAGES,
} from "../fs/storage-geometry";
import {
  createRig,
  fillFirstSegment,
  sameBacking,
  settle,
  type Cleanup,
} from "./fixtures/lazy-backing.js";

const cleanups: Cleanup[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const file = (ino: number, size: number) => ({
  kind: "file" as const,
  ino,
  nlink: 1,
  size,
  mtime: 1,
});
/** Refuses the owner's next `count` new segment constructions, as a native RangeError would. */
function refuseSegments(state: SharedFilesystemState, refused: (attempt: number) => boolean) {
  const target = state as unknown as { ensureSegment(segment: number): void };
  const ensure = target.ensureSegment;
  let attempts = 0;
  target.ensureSegment = function (this: SharedFilesystemState, segment: number) {
    if (segment > 0 && !this.segments[segment] && refused(++attempts))
      throw new RangeError("injected segment refusal");
    return Reflect.apply(ensure, this, [segment]);
  };
  return () => {
    target.ensureSegment = ensure;
  };
}

test("the default pool admits an application budget beyond the exhausted GiB lazily", () => {
  const applicationBytes = 1024 * 1024 * 1024 + SHARED_SEGMENT_BYTES;
  const root = createFilesystemIdentity();
  expect(root.maxBytes).toBeGreaterThanOrEqual(applicationBytes);
  const identity = createFilesystemIdentity(undefined, applicationBytes);
  expect(identity.maxBytes).toBe(applicationBytes);
  const state = new SharedFilesystemState(identity.shared, identity.maxBytes);
  expect(state.buffer.byteLength).toBe(CONNECTION_SHARED_BYTES);
  expect(state.resources()).toMatchObject({
    maxBytes: applicationBytes,
    poolBytes: SHARED_SEGMENT_BYTES,
    usedBytes: 0,
  });
  state.register(0, file(1, PAGE * 6));
  state.grow(0, PAGE * 6 + 1);
  expect(state.info(0)?.capacity).toBe(PAGE * 12);
  expect(state.resources().usedBytes).toBe(PAGE * 12);
  expect(state.segments).toHaveLength(1);
});

test("an independent identity holds no extra backing and a fork shares its parent's directory", () => {
  const root = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 3);
  expect(root.maxBytes).toBe(SHARED_SEGMENT_BYTES * 3);
  expect(root.segments).toEqual([]);
  const child = createFilesystemIdentity(root);
  expect(child.segments).toBe(root.segments);
  expect(child.shared).toBe(root.shared);
});

test("the default cap is advertised in full while nothing beyond the root exists", () => {
  const rig = createRig(96, cleanups);
  expect(rig.identity.maxBytes).toBe(1_610_612_736);
  expect(rig.identity.segments).toEqual([]);
  expect(rig.backend.shared.segments).toHaveLength(1);
  expect(rig.backend.shared.resources()).toMatchObject({
    poolBytes: SHARED_SEGMENT_BYTES,
    usedBytes: 0,
    maxBytes: rig.identity.maxBytes,
  });
});

test("only the owner builds a segment, as one fixed 16 MiB buffer", () => {
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 2);
  const owner = new SharedFilesystemState(identity.shared, identity.maxBytes);
  const guest = new SharedFilesystemState(identity.shared, identity.maxBytes, identity.owner);
  owner.register(0, file(1, SHARED_SEGMENT_BYTES));
  expect(owner.segments).toHaveLength(1);
  // A second builder would make backing the owner never sees.
  expect(() => guest.register(1, file(2, PAGE))).toThrow(MissingSegmentError);
  expect(guest.segments).toHaveLength(1);
  expect(guest.takeNewSegments()).toEqual([]);
  expect(owner.segments).toHaveLength(1);
  expect(owner.resources().usedBytes).toBe(SHARED_SEGMENT_BYTES);
  owner.register(1, file(2, PAGE));
  const built = owner.segments[1]!;
  expect(built.byteLength).toBe(SHARED_SEGMENT_BYTES);
  expect(Reflect.get(built, "growable")).toBe(false);
  expect(Reflect.get(built, "maxByteLength")).toBe(SHARED_SEGMENT_BYTES);
  expect(owner.takeNewSegments()).toEqual([{ buffer: built, index: 1 }]);
});

test("an announced segment is attached once, by index, at its full length", () => {
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 4);
  const owner = new SharedFilesystemState(identity.shared, identity.maxBytes);
  const guest = new SharedFilesystemState(identity.shared, identity.maxBytes, identity.owner);
  owner.register(0, file(1, SHARED_SEGMENT_BYTES * 2 + PAGE));
  const [first, second] = owner.takeNewSegments();
  expect([first!.index, second!.index]).toEqual([1, 2]);
  // Out of order, and with a hole below it.
  guest.addSegment(second!.buffer, 2);
  expect(1 in guest.segments).toBe(false);
  const duplicate = structuredClone(second!.buffer);
  guest.addSegment(duplicate, 2);
  expect(guest.segments[2]).toBe(second!.buffer);
  expect(() => guest.addSegment(new SharedArrayBuffer(PAGE), 1)).toThrow(RangeError);
  expect(() => guest.addSegment(first!.buffer, 4)).toThrow(RangeError);
  expect(() => guest.addSegment(first!.buffer, 0)).toThrow(RangeError);
  guest.addSegment(first!.buffer, 1);
  expect(guest.segments[1]).toBe(first!.buffer);
});

test("a synchronous guest that never yields reaches service-built segments through the owner", async () => {
  const rig = createRig(2, cleanups);
  await fillFirstSegment(rig);
  await rig.client.asyncCall("writeFile", ["/extra"], new Uint8Array());
  const connection = rig.client.fork();
  const guest = new Worker(new URL("./fixtures/filesystem-segment-guest.ts", import.meta.url).href);
  cleanups.push(() => {
    guest.terminate();
    reapFilesystem(connection);
    rig.service.sweep();
  });
  const result = new Promise<any>((resolve, reject) => {
    guest.onmessage = ({ data }) => resolve(data);
    guest.onerror = reject;
  });
  guest.postMessage({ connection }, [connection.port]);
  const value = await result;
  expect(value).toMatchObject({
    written: 2,
    appended: { written: 2, offset: 4 },
    snapshots: Array.from({ length: 4 }, () => [65, 66, 67, 68]),
    // The guest never returned to its event loop, so no segment could be delivered to it.
    turns: 0,
    attachedBefore: 1,
    attachedAfter: 1,
  });
  // Growth built the segment at the owner. Every byte after that went through the owner.
  expect(value.operations[0]).toBe("grow");
  expect(value.operations).toContain("write");
  expect(value.operations).toContain("append");
  expect(value.operations).toContain("read");
  expect(await rig.client.asyncCall("readFile", ["/extra"])).toEqual(
    new Uint8Array([65, 66, 67, 68]),
  );
  expect(rig.backend.shared.resources().poolBytes).toBe(SHARED_SEGMENT_BYTES * 2);
});

test("a client that yields attaches the announced segment and then reads with no request", async () => {
  const rig = createRig(3, cleanups);
  await fillFirstSegment(rig);
  await rig.client.asyncCall("writeFile", ["/target"], new Uint8Array(PAGE).fill(0xa7));
  await settle();
  const built = rig.backend.shared.segments[1];
  expect(sameBacking(rig.client.shared.segments[1], built)).toBe(true);
  // Later forks from this agent start with the segment in their launch snapshot.
  expect(sameBacking(rig.client.connection.segments[0], built)).toBe(true);
  expect(sameBacking(rig.client.fork().segments[0], built)).toBe(true);
  const root = await rig.client.asyncCall("preopen", ["/"]);
  const node = (await rig.client.asyncCall("resolve", [root, "target"])).node as number;
  rig.client.retain(node);
  const operations: string[] = [];
  const submit = rig.client.submit.bind(rig.client);
  rig.client.submit = (...args) => {
    operations.push(args[0]);
    return submit(...args);
  };
  const bytes = new Uint8Array(16);
  expect(rig.client.tryRead(node, [bytes], 0)).toBe(16);
  expect(bytes.every((byte) => byte === 0xa7)).toBe(true);
  expect(operations).toEqual([]);
});

test("the real storage cap is preserved and only built backing is reported", async () => {
  const rig = createRig(2, cleanups);
  const { backend, client } = rig;
  await client.asyncCall("writeFile", ["/first"], new Uint8Array(SHARED_SEGMENT_BYTES));
  expect(backend.shared.resources().poolBytes).toBe(SHARED_SEGMENT_BYTES);
  await client.asyncCall("writeFile", ["/second"], new Uint8Array(SHARED_SEGMENT_BYTES - PAGE));
  expect(
    await client
      .asyncCall("writeFile", ["/overflow"], new Uint8Array(PAGE * 2))
      .catch((error) => error),
  ).toMatchObject({ errno: 51 });
  expect(backend.shared.resources().usedBytes).toBe(SHARED_SEGMENT_BYTES * 2 - PAGE);
  await client.asyncCall("writeFile", ["/last-page"], new Uint8Array(PAGE));
  expect(backend.shared.resources()).toMatchObject({
    poolBytes: SHARED_SEGMENT_BYTES * 2,
    usedBytes: SHARED_SEGMENT_BYTES * 2,
    maxBytes: SHARED_SEGMENT_BYTES * 2,
  });
  expect(
    await client.asyncCall("writeFile", ["/overflow"], new Uint8Array([1])).catch((error) => error),
  ).toMatchObject({ errno: 51 });
  expect(backend.shared.resources().usedBytes).toBe(SHARED_SEGMENT_BYTES * 2);
  await client.asyncCall("remove", ["/first"]);
  await client.asyncCall("writeFile", ["/overflow"], new Uint8Array([7]));
  expect(await client.asyncCall("readFile", ["/overflow"])).toEqual(new Uint8Array([7]));
  expect(backend.shared.resources()).toMatchObject({
    poolBytes: SHARED_SEGMENT_BYTES * 2,
    usedBytes: SHARED_SEGMENT_BYTES + PAGE,
  });
  // Recycled pages read back as zero.
  await client.asyncCall("writeFile", ["/reuse"], new Uint8Array(1));
  const root = await client.asyncCall("preopen", ["/"]);
  const node = (await client.asyncCall("resolve", [root, "reuse"])).node as number;
  await client.asyncCall("resize", [node, PAGE * 4, false]);
  const reused = (await client.asyncCall("readFile", ["/reuse"])) as Uint8Array;
  expect(reused).toHaveLength(PAGE * 4);
  expect(reused.every((byte) => byte === 0)).toBe(true);
});

test("root storage caps normalize to whole segments and stay bounded", () => {
  for (const [requested, expected] of [
    [0, SHARED_SEGMENT_BYTES],
    [SHARED_SEGMENT_BYTES * 2 + 1, SHARED_SEGMENT_BYTES * 2],
    [1024 * 1024 * 1024, 1024 * 1024 * 1024],
    [Number.POSITIVE_INFINITY, 1536 * 1024 * 1024],
  ]) {
    const identity = createFilesystemIdentity(undefined, requested);
    expect(identity.maxBytes).toBe(expected!);
    expect(identity.segments).toEqual([]);
  }
  expect(() => createFilesystemIdentity(undefined, NaN)).toThrow(RangeError);
});

test("a refused segment construction rolls back the request and a later one succeeds", () => {
  const identity = createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 2);
  const state = new SharedFilesystemState(identity.shared, identity.maxBytes);
  const held = DATA_PAGES_PER_SEGMENT - 1;
  state.register(0, file(1, PAGE * held));
  const restore = refuseSegments(state, () => true);
  try {
    let failure: unknown;
    try {
      state.register(1, file(2, PAGE * 2));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ errno: 51 });
    expect(Array.from(state.owners).filter((owner) => owner !== 0)).toHaveLength(held);
    expect(state.resources()).toMatchObject({
      poolBytes: SHARED_SEGMENT_BYTES,
      usedBytes: PAGE * held,
    });
    expect(state.segments).toHaveLength(1);
    expect(state.takeNewSegments()).toEqual([]);
  } finally {
    restore();
  }
  state.register(2, file(3, PAGE * 2));
  expect(state.resources()).toMatchObject({
    poolBytes: SHARED_SEGMENT_BYTES * 2,
    usedBytes: PAGE * (held + 2),
  });
  expect(state.takeNewSegments().map((segment) => segment.index)).toEqual([1]);
});

test("a second construction refusal keeps the first segment and commits no file page", async () => {
  const rig = createRig(4, cleanups);
  await fillFirstSegment(rig);
  const owner = rig.backend.shared;
  const used = owner.resources().usedBytes;
  const announced: number[] = [];
  const port = rig.pair.server.port;
  const post = port.postMessage.bind(port);
  port.postMessage = (message: any, ...rest: any[]) => {
    if (message?.segment) announced.push(message.segment);
    return Reflect.apply(post, port, [message, ...rest]);
  };
  const restore = refuseSegments(owner, (attempt) => attempt === 2);
  const failure = await rig.client
    .asyncCall("writeFile", ["/split"], new Uint8Array(SHARED_SEGMENT_BYTES + PAGE * 2).fill(3))
    .catch((error: unknown) => error);
  restore();
  expect(failure).toMatchObject({ errno: 51 });
  // Built backing survives the failure. File pages do not.
  expect(owner.segments[1]?.byteLength).toBe(SHARED_SEGMENT_BYTES);
  expect(2 in owner.segments).toBe(false);
  expect(owner.resources().usedBytes).toBe(used);
  expect(owner.resources().poolBytes).toBe(SHARED_SEGMENT_BYTES * 2);
  const split = await rig.client.asyncCall("readFile", ["/split"]).catch(() => undefined);
  expect(split === undefined || (split as Uint8Array).length === 0).toBe(true);
  await settle();
  expect(announced).toEqual([1]);
  expect(sameBacking(rig.client.shared.segments[1], owner.segments[1])).toBe(true);
  // The retained segment serves the next write, with no second announcement.
  await rig.client.asyncCall("writeFile", ["/ok"], new Uint8Array(PAGE).fill(4));
  expect(((await rig.client.asyncCall("readFile", ["/ok"])) as Uint8Array)[0]).toBe(4);
  await settle();
  expect(announced).toEqual([1]);
});

test("the last page of the full default cap is addressable and the next is refused", () => {
  const state = new SharedFilesystemState();
  const lastPage = TOTAL_DATA_PAGES - 1;
  state.owners.fill(1, 0, lastPage);
  state.register(0, file(1, PAGE));
  expect(state.owners[lastPage]).not.toBe(0);
  // Only segment 95 was built: holes below it are not a smaller cap.
  expect(state.segments[95]?.byteLength).toBe(SHARED_SEGMENT_BYTES);
  expect(state.segments.filter(Boolean)).toHaveLength(2);
  expect(state.takeNewSegments().map((segment) => segment.index)).toEqual([95]);
  expect(() => state.register(1, file(2, PAGE))).toThrow(
    expect.objectContaining({ errno: 51 }) as never,
  );
});

test("a foreign root cannot attach to an owner", () => {
  const rig = createRig(2, cleanups);
  const foreign = connectFilesystemIdentity(
    createFilesystemIdentity(undefined, SHARED_SEGMENT_BYTES * 2),
  );
  cleanups.push(() => {
    foreign.client.port.close();
    foreign.server.port.close();
  });
  expect(() => rig.service.connect(foreign.server)).toThrow("second shared tree");
});
