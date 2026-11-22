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
