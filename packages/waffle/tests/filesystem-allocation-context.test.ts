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
    const detail = formatHostError(new Error("Notification scenario sendFailure failed", { cause: original }));
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
      kind: "independent", stage: "root", rootComplete: false,
      segmentSlot: null, segmentsCompleted: 0, segmentsPlanned: 95,
    });
  } finally {
    restore();
  }
});

test("inherited control failure does not claim a new root or segments", () => {
  const parent = createFilesystemIdentity();
  const original = new RangeError("inherited capabilities failure");
  const restore = installSharedControlAllocator(() => { throw original; });
  try {
    expect(capture(() => createFilesystemIdentity(parent))).toBe(original);
    expect(snapshot(original)).toMatchObject({
      kind: "inherited", stage: "identity", rootOrdinal: null, rootComplete: true,
      segmentSlot: null, segmentsCompleted: 0, segmentsPlanned: 0,
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
