import { expect, spyOn, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { createFilesystemConnection, pack, unpack } from "../fs/protocol";
import { FilesystemService } from "../fs/service";

const bytes = (value: string) => new TextEncoder().encode(value);

test("untagged payloads decode to plain data without a transport pass", () => {
  const value = {
    name: "entry",
    list: [1, "two", null, { deep: [true] }],
    text: 'quote " then $dollar and "$ inside a string',
  };
  expect(unpack(pack(value))).toEqual(value);
  expect(unpack(bytes("null"))).toBeNull();
  expect(unpack(bytes("7"))).toBe(7);
  expect(unpack(bytes('"$bigint"'))).toBe("$bigint");
});

test("tags decode in place inside plain objects and arrays", () => {
  const value = {
    kind: "file",
    size: 4096,
    atime: 1700000000000000000n,
    nested: { list: [1, { big: -(1n << 70n) }, new Uint8Array([0, 255])], gone: undefined },
    map: new Map<unknown, unknown>([["k", { v: 5n }]]),
    $other: 1,
  };
  const decoded = unpack(pack(value));
  expect(decoded).toEqual({ ...value, nested: { list: value.nested.list } });
  expect(Object.hasOwn(decoded.nested, "gone")).toBe(false);
  expect(Object.keys(decoded)).toEqual(["kind", "size", "atime", "nested", "map", "$other"]);
  expect(decoded.nested.list[2]).toBeInstanceOf(Uint8Array);
});

test("an inherited tag key does not turn a plain object into a tag", () => {
  Object.defineProperty(Object.prototype, "$bigint", { value: "5", configurable: true });
  try {
    // The bigint tag forces the tagged decode path, which then visits the plain objects.
    const wire = bytes('{"big":{"$bigint":"1"},"plain":{"b":1}}');
    expect(unpack(wire)).toEqual({ big: 1n, plain: { b: 1 } });
  } finally {
    Reflect.deleteProperty(Object.prototype, "$bigint");
  }
});

test("an escaped tag key is still a tag", () => {
  expect(unpack(bytes('{"\\u0024bigint":"42"}'))).toBe(42n);
  expect(unpack(bytes('{"a":{"\\u0024undefined":true}}'))).toEqual({});
});

test("views over shared and resizable backing decode like plain ones", () => {
  const plain = { id: 7n, names: ["a", "b"] };
  const untagged = { names: ["a", "b"] };
  const packedPlain = pack(plain);
  const packedUntagged = pack(untagged);
  const shared = new SharedArrayBuffer(1024);
  const resizable = new ArrayBuffer(1024, { maxByteLength: 4096 });
  for (const buffer of [shared, resizable]) {
    new Uint8Array(buffer, 16, packedPlain.length).set(packedPlain);
    expect(unpack(new Uint8Array(buffer, 16, packedPlain.length))).toEqual(plain);
    new Uint8Array(buffer, 16, packedUntagged.length).set(packedUntagged);
    expect(unpack(new Uint8Array(buffer, 16, packedUntagged.length))).toEqual(untagged);
  }
});

test("fixing up tags leaves inherited enumerable properties alone", () => {
  const owned = Object.assign(Object.create(null), { counter: { $bigint: "42" } });
  Object.defineProperty(Object.prototype, "ownedByCaller", {
    value: owned,
    enumerable: true,
    configurable: true,
  });
  try {
    expect(unpack(pack({ id: 7n, name: "x" }))).toEqual({ id: 7n, name: "x" });
    expect(owned.counter).toEqual({ $bigint: "42" });
  } finally {
    delete (Object.prototype as Record<string, unknown>).ownedByCaller;
  }
});

test("a later replacement of String.prototype.includes cannot hide a tag", () => {
  const includes = String.prototype.includes;
  String.prototype.includes = () => false;
  try {
    expect(unpack(bytes('{"sent":{"$bigint":"7"}}'))).toEqual({ sent: 7n });
  } finally {
    String.prototype.includes = includes;
  }
});

class GatedBackend extends MemoryBackend {
  gate: Promise<void> = Promise.resolve();
  override execute(operation: string, args: any[], data: Uint8Array): unknown {
    return this.gate.then(() => super.execute(operation, args, data));
  }
}

test("a blocked queue does not keep large decoded requests alive", async () => {
  const backend = new GatedBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const decoded: WeakRef<object>[] = [];
  const nativeParse = JSON.parse;
  let open!: () => void;
  const pending: Promise<unknown>[] = [];
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    backend.gate = new Promise<void>((resolve) => (open = resolve));
    const parse = spyOn(JSON, "parse").mockImplementation((text: string) => {
      const value = nativeParse(text);
      if (text.length > 100_000) decoded.push(new WeakRef(value));
      return value;
    });
    try {
      const big = Array.from({ length: 250_000 }, (_, index) => index);
      for (let index = 0; index < 8; index++)
        pending.push(client.asyncCall("stat", [root, big]).catch(() => {}));
      await Bun.sleep(50);
    } finally {
      parse.mockRestore();
    }
    // Every queued request was decoded at least once, so the retention check below is meaningful.
    expect(decoded.length).toBeGreaterThanOrEqual(8);
    Bun.gc(true);
    await Bun.sleep(20);
    Bun.gc(true);
    // Only a request that has reached the backend may hold its decoded form.
    expect(decoded.filter((ref) => ref.deref()).length).toBeLessThanOrEqual(1);
  } finally {
    open();
    await Promise.all(pending);
    client.dispose();
    await service.dispose();
  }
});

test("a request is decoded once by the service and once by the client", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    await client.asyncCall("mkdirp", ["/sub"]);
    const parse = spyOn(JSON, "parse");
    try {
      const stat = await client.asyncCall("stat", [
        (await client.asyncCall("resolve", [root, "sub", true])).node,
      ]);
      expect(stat.kind).toBeDefined();
      // resolve and stat, each: the service decodes the request, the client decodes the reply.
      expect(parse).toHaveBeenCalledTimes(4);
    } finally {
      parse.mockRestore();
    }
    // A barrier operation is detected from the same decode and still serializes.
    await client.asyncCall("flush", []);
  } finally {
    client.dispose();
    await service.dispose();
  }
});
