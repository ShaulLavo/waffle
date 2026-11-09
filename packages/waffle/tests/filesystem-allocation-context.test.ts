import { expect, test } from "bun:test";
import {
  createFilesystemIdentity,
  createFilesystemConnection,
  SHARED_SEGMENT_BYTES,
} from "../fs/protocol.js";
import { SHARED_ROOT_BYTES } from "../fs/storage-geometry.js";
import { installSharedControlAllocator } from "../memory/allocator.js";
import { formatHostError } from "./page-runner/protocol.js";

const NativeSharedArrayBuffer = globalThis.SharedArrayBuffer;
function segmentFailure(slot: number, original: unknown) {
  let attempts = 0;
  globalThis.SharedArrayBuffer = new Proxy(NativeSharedArrayBuffer, {
    construct(target, args) {
      if (args[0] === 0 && ++attempts === slot) throw original;
      return Reflect.construct(target, args);
    },
  });
  try {
    return capture(() => createFilesystemIdentity());
  } finally {
    globalThis.SharedArrayBuffer = NativeSharedArrayBuffer;
  }
}
function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("fault did not reach its source boundary");
}
function snapshot(error: unknown) {
  return Object.getOwnPropertyDescriptor(error, "filesystemAllocation")?.value;
}

for (const slot of [1, 5, 95]) {
  test(`filesystem allocation failure identifies original segment ${slot}`, () => {
    const original = new RangeError("original segment failure", { cause: "native cause" });
    const stack = original.stack;
    expect(segmentFailure(slot, original)).toBe(original);
    expect(original.cause).toBe("native cause");
    expect(original.stack).toBe(stack);
    expect(snapshot(original)).toMatchObject({
      kind: "independent",
      stage: "segments",
      rootComplete: true,
      segmentSlot: slot,
      segmentsCompleted: slot - 1,
      segmentsPlanned: 95,
    });
    const detail = formatHostError(
      new Error("Notification scenario sendFailure failed", { cause: original }),
    );
    expect(detail).toContain(`"segmentSlot":${slot}`);
    expect(detail).toContain("original segment failure");
    expect(detail).toContain("native cause");
  });
}

test("root failure precedes every extra segment and connection allocation", () => {
  const original = new RangeError("original root failure");
  const lengths: number[] = [];
  const restore = installSharedControlAllocator((length) => {
    lengths.push(length);
    throw original;
  });
  try {
    expect(capture(() => createFilesystemConnection())).toBe(original);
    expect(lengths).toEqual([SHARED_ROOT_BYTES]);
    expect(snapshot(original)).toMatchObject({
      kind: "independent",
      stage: "root",
      rootComplete: false,
      segmentSlot: null,
      segmentsCompleted: 0,
      segmentsPlanned: 95,
    });
  } finally {
    restore();
  }
});

test("inherited control failure does not claim a new root or segments", () => {
  const parent = createFilesystemIdentity();
  const original = new RangeError("inherited capabilities failure");
  const restore = installSharedControlAllocator(() => {
    throw original;
  });
  try {
    expect(capture(() => createFilesystemIdentity(parent))).toBe(original);
    expect(snapshot(original)).toMatchObject({
      kind: "inherited",
      stage: "identity",
      rootOrdinal: null,
      rootComplete: true,
      segmentSlot: null,
      segmentsCompleted: 0,
      segmentsPlanned: 0,
    });
  } finally {
    restore();
  }
});

test("normal identities preserve independent allocation geometry and inherited storage", () => {
  const parent = createFilesystemIdentity();
  const child = createFilesystemIdentity(parent);
  expect(parent.shared.byteLength).toBe(SHARED_ROOT_BYTES);
  expect(parent.segments).toHaveLength(95);
  for (const segment of parent.segments) {
    expect(segment.byteLength).toBe(0);
    expect(Reflect.get(segment, "maxByteLength")).toBe(SHARED_SEGMENT_BYTES);
  }
  expect(child.shared).toBe(parent.shared);
  expect(child.segments).toBe(parent.segments);
  expect(child.ownerStates).toBe(parent.ownerStates);
  expect(child.capabilities).not.toBe(parent.capabilities);
  expect(Object.hasOwn(parent, "filesystemAllocation")).toBe(false);
  expect(Object.hasOwn(child, "filesystemAllocation")).toBe(false);
});

for (const boundary of [1, 2, 3, 4, 5, 6]) {
  test(`independent identity control allocation ${boundary} retains completed storage progress`, () => {
    const original = new RangeError("original control failure");
    let controls = 0;
    const restore = installSharedControlAllocator((length) => {
      if (length !== SHARED_ROOT_BYTES && ++controls === boundary) throw original;
      return new NativeSharedArrayBuffer(length);
    });
    try {
      expect(capture(() => createFilesystemIdentity())).toBe(original);
      expect(snapshot(original)).toMatchObject({
        kind: "independent",
        stage: "identity",
        rootComplete: true,
        segmentSlot: null,
        segmentsCompleted: 95,
        segmentsPlanned: 95,
      });
    } finally {
      restore();
    }
  });
}

test("provided storage reports only its own segment constructors", () => {
  const original = new RangeError("provided segment failure");
  const shared = new NativeSharedArrayBuffer(SHARED_ROOT_BYTES);
  let segments = 0;
  const construction = {
    shared,
    allocateShared(length: number, maximum?: number) {
      if (maximum !== undefined && ++segments === 5) throw original;
      return maximum === undefined
        ? new NativeSharedArrayBuffer(length)
        : Reflect.construct(NativeSharedArrayBuffer, [length, { maxByteLength: maximum }]);
    },
  };
  expect(capture(() => createFilesystemConnection(undefined, undefined, construction))).toBe(
    original,
  );
  expect(snapshot(original)).toMatchObject({
    kind: "provided",
    stage: "segments",
    rootOrdinal: null,
    rootComplete: true,
    segmentSlot: 5,
    segmentsCompleted: 4,
    segmentsPlanned: 95,
  });
});

for (const original of [
  Object.freeze(new RangeError("frozen failure")),
  "primitive failure",
  null,
]) {
  test(`unannotatable ${String(original)} escapes unchanged`, () => {
    expect(segmentFailure(1, original)).toBe(original);
  });
}

test("copied failure metadata is scalar-only and does not change after later identities", () => {
  const first = new RangeError("first");
  segmentFailure(5, first);
  const before = structuredClone(snapshot(first));
  const second = new RangeError("second");
  segmentFailure(1, second);
  createFilesystemIdentity();
  expect(snapshot(first)).toEqual(before);
  expect(snapshot(second).identityOrdinal).toBe(before.identityOrdinal + 1);
  expect(snapshot(second).rootOrdinal).toBe(before.rootOrdinal + 1);
  for (const value of Object.values(before)) {
    expect(value === null || ["string", "boolean", "number"].includes(typeof value)).toBe(true);
  }
  expect(Object.keys(before)).toHaveLength(8);
  expect(Object.keys(first)).toEqual([]);
});

test("host diagnostics copy only bounded scalars without calling metadata getters", () => {
  const error = new RangeError("original failure");
  segmentFailure(1, error);
  Object.defineProperty(snapshot(error), "unrelated", {
    get() {
      throw new Error("must not read");
    },
  });
  expect(formatHostError(error)).toContain('"segmentSlot":1');
  Object.defineProperty(snapshot(error), "segmentSlot", {
    get() {
      throw new Error("must not read");
    },
  });
  expect(formatHostError(error)).toContain("original failure");
  expect(formatHostError(error)).not.toContain("Filesystem allocation:");
});
