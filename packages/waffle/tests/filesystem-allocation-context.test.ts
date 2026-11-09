import { expect, test } from "bun:test";
import { createFilesystemIdentity, createFilesystemConnection } from "../fs/protocol.js";
import { SHARED_ROOT_BYTES } from "../fs/storage-geometry.js";
import { installSharedControlAllocator } from "../memory/allocator.js";
import { formatHostError } from "./page-runner/protocol.js";

const NativeSharedArrayBuffer = globalThis.SharedArrayBuffer;
/** Fails the given control allocation of one independent identity, counting after its root. */
function controlFailure(boundary: number, original: unknown) {
  let controls = 0;
  const restore = installSharedControlAllocator((length) => {
    if (length !== SHARED_ROOT_BYTES && ++controls === boundary) throw original;
    return new NativeSharedArrayBuffer(length);
  });
  try {
    return capture(() => createFilesystemIdentity());
  } finally {
    restore();
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

test("root failure precedes every identity and connection allocation", () => {
  const original = new RangeError("original root failure");
  const lengths: number[] = [];
  const restore = installSharedControlAllocator((length) => {
    lengths.push(length);
    throw original;
  });
  try {
    expect(capture(() => createFilesystemConnection())).toBe(original);
    expect(lengths).toEqual([SHARED_ROOT_BYTES]);
    expect(snapshot(original)).toEqual({
      identityOrdinal: expect.any(Number),
      rootOrdinal: expect.any(Number),
      kind: "independent",
      stage: "root",
      rootComplete: false,
    });
  } finally {
    restore();
  }
});

test("inherited control failure does not claim a new root", () => {
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
    });
  } finally {
    restore();
  }
});

test("normal identities allocate one root, no data segment, and inherit storage", () => {
  const parent = createFilesystemIdentity();
  const child = createFilesystemIdentity(parent);
  expect(parent.shared.byteLength).toBe(SHARED_ROOT_BYTES);
  expect(parent.segments).toEqual([]);
  expect(child.shared).toBe(parent.shared);
  expect(child.segments).toBe(parent.segments);
  expect(child.ownerStates).toBe(parent.ownerStates);
  expect(child.capabilities).not.toBe(parent.capabilities);
  expect(Object.hasOwn(parent, "filesystemAllocation")).toBe(false);
  expect(Object.hasOwn(child, "filesystemAllocation")).toBe(false);
});

for (const boundary of [1, 2, 3, 4, 5, 6]) {
  test(`independent identity control allocation ${boundary} follows a complete root`, () => {
    const original = new RangeError("original control failure", { cause: "native cause" });
    const stack = original.stack;
    expect(controlFailure(boundary, original)).toBe(original);
    expect(original.cause).toBe("native cause");
    expect(original.stack).toBe(stack);
    expect(snapshot(original)).toMatchObject({
      kind: "independent",
      stage: "identity",
      rootComplete: true,
    });
    const detail = formatHostError(
      new Error("Notification scenario sendFailure failed", { cause: original }),
    );
    expect(detail).toContain('"stage":"identity"');
    expect(detail).toContain("original control failure");
    expect(detail).toContain("native cause");
  });
}

test("provided storage asks its construction for control buffers only, never a data segment", () => {
  const original = new RangeError("provided control failure");
  const shared = new NativeSharedArrayBuffer(SHARED_ROOT_BYTES);
  const requests: { length: number; maximum: number | undefined }[] = [];
  const construction = {
    shared,
    allocateShared(length: number, maximum?: number) {
      requests.push({ length, maximum });
      if (requests.length === 5) throw original;
      return new NativeSharedArrayBuffer(length);
    },
  };
  expect(capture(() => createFilesystemConnection(undefined, undefined, construction))).toBe(
    original,
  );
  expect(requests.every(({ maximum }) => maximum === undefined)).toBe(true);
  expect(snapshot(original)).toMatchObject({
    kind: "provided",
    stage: "identity",
    rootOrdinal: null,
    rootComplete: true,
  });
});

for (const original of [
  Object.freeze(new RangeError("frozen failure")),
  "primitive failure",
  null,
]) {
  test(`unannotatable ${String(original)} escapes unchanged`, () => {
    expect(controlFailure(1, original)).toBe(original);
  });
}

test("copied failure metadata is scalar-only and does not change after later identities", () => {
  const first = new RangeError("first");
  controlFailure(5, first);
  const before = structuredClone(snapshot(first));
  const second = new RangeError("second");
  controlFailure(1, second);
  createFilesystemIdentity();
  expect(snapshot(first)).toEqual(before);
  expect(snapshot(second).identityOrdinal).toBe(before.identityOrdinal + 1);
  expect(snapshot(second).rootOrdinal).toBe(before.rootOrdinal + 1);
  for (const value of Object.values(before)) {
    expect(value === null || ["string", "boolean", "number"].includes(typeof value)).toBe(true);
  }
  expect(Object.keys(before)).toEqual([
    "identityOrdinal",
    "rootOrdinal",
    "kind",
    "stage",
    "rootComplete",
  ]);
  expect(Object.keys(first)).toEqual([]);
});

test("host diagnostics copy only bounded scalars without calling metadata getters", () => {
  const error = new RangeError("original failure");
  controlFailure(1, error);
  Object.defineProperty(snapshot(error), "unrelated", {
    get() {
      throw new Error("must not read");
    },
  });
  expect(formatHostError(error)).toContain('"stage":"identity"');
  Object.defineProperty(snapshot(error), "stage", {
    get() {
      throw new Error("must not read");
    },
  });
  expect(formatHostError(error)).toContain("original failure");
  expect(formatHostError(error)).not.toContain("Filesystem allocation:");
});

test("revoked allocation metadata leaves the original failure report intact", () => {
  const metadata = Proxy.revocable({}, {});
  const original = new RangeError("original native failure", { cause: "native cause" });
  const stack = original.stack;
  Object.defineProperty(original, "filesystemAllocation", { value: metadata.proxy });
  metadata.revoke();
  expect(controlFailure(5, original)).toBe(original);
  const detail = formatHostError(
    new Error("Notification scenario sendFailure failed", { cause: original }),
  );
  expect(detail).toContain("Notification scenario sendFailure failed");
  expect(detail).toContain("original native failure");
  expect(detail).toContain("native cause");
  expect(detail).not.toContain("Filesystem allocation:");
  expect(original.stack).toBe(stack);
});
