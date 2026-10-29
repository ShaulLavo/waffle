import { afterEach, expect, spyOn, test } from "bun:test";
import { FilesystemError } from "../core/filesystem.js";
import { RIGHT_PATH_READLINK } from "../core/rights.js";
import { Wasi } from "../core/wasi.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { MemFS, type Node } from "../fs/memory.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";
import { guestFunction, guestModule } from "./fixtures/publication-wasm.js";

const stops: (() => void)[] = [];
const encoder = new TextEncoder();
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

class ObservedFS extends MemFS {
  readlinks = 0;
  stats = 0;
  onReadlink = () => {};
  readlink(handle: number): string {
    this.readlinks++;
    const target = super.readlink(handle);
    this.onReadlink();
    return target;
  }
  stat(handle: number) {
    this.stats++;
    return super.stat(handle);
  }
}
function resolve(fs: MemFS, path: string) {
  const result = fs.resolveAbsolute(path);
  if (typeof result === "number") throw new FilesystemError(result);
  return result;
}
function link(fs: MemFS, path: string, target: string) {
  expect(fs.symlink(resolve(fs, path), target)).toBe(0);
}
function snapshotNode(node: Node): unknown {
  if (node.kind === "dir")
    return {
      ino: node.ino,
      mtime: node.mtime,
      children: Array.from(node.children, ([name, child]) => [name, snapshotNode(child)]),
    };
  return {
    ino: node.ino,
    mtime: node.mtime,
    value: node.kind === "file" ? Array.from(node.data) : node.kind === "symlink" ? node.target : undefined,
  };
}
function fixture(target = "../raw//é/雪/🙂", memory = new WebAssembly.Memory({ initial: 4 })) {
  const fs = new ObservedFS();
  fs.writeFile("/ordinary.txt", "unchanged text");
  fs.mkdirp("/directory");
  link(fs, "/link", target);
  const diagnostics: string[] = [];
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
    diagnostic(bytes) {
      diagnostics.push(new TextDecoder().decode(bytes));
    },
  });
  stops.push(() => wasi.descriptors.dispose());
  const module = guestModule("wasi_snapshot_preview1", [
    { name: "path_readlink", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "fd_close", parameters: ["i32"] },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const put = (value: string, at = 128) => {
    const input = encoder.encode(value);
    new Uint8Array(memory.buffer).set(input, at);
    return input.length;
  };
  const readlink = (fd = 3, ptr = 128, len = 4, out = 512, capacity = 32, used = 256) =>
    guestFunction(instance, "path_readlink")(fd, ptr, len, out, capacity, used);
  put("link");
  fs.readlinks = 0;
  fs.stats = 0;
  return { fs, memory, wasi, diagnostics, put, readlink, instance, target };
}

test.each(["input tail", "input past end", "output tail", "used tail", "zero output past end"])(
  "D4 rejects an ordinary invalid %s span before filesystem or output work",
  (boundary) => {
    const f = fixture();
    const end = f.memory.buffer.byteLength;
    const last = f.put("link", end - 4);
    const args = { ptr: 128, len: 4, out: 512, capacity: 32, used: 256 };
    if (boundary === "input tail") {
      args.ptr = end - last;
      args.len = last + 1;
    }
    if (boundary === "input past end") {
      args.ptr = end;
      args.len = 1;
    }
    if (boundary === "output tail") {
      args.out = end - 2;
      args.capacity = 3;
    }
    if (boundary === "used tail") args.used = end - 3;
    if (boundary === "zero output past end") {
      args.out = end + 1;
      args.capacity = 0;
    }
    const before = new Uint8Array(f.memory.buffer).slice();
    const tree = snapshotNode(f.fs.root);
    const encoding = spyOn(TextEncoder.prototype, "encode");
    stops.push(() => encoding.mockRestore());
    expect(f.readlink(3, args.ptr, args.len, args.out, args.capacity, args.used)).toBe(21);
    expect(new Uint8Array(f.memory.buffer)).toEqual(before);
    expect(f.fs.readlinks).toBe(0);
    expect(f.fs.stats).toBe(0);
    expect(encoding).not.toHaveBeenCalled();
    expect(snapshotNode(f.fs.root)).toEqual(tree);
    expect(f.diagnostics).toEqual([]);
  },
);

test("D4 selects memory-error precedence even for a closed descriptor", () => {
  const f = fixture();
  expect(guestFunction(f.instance, "fd_close")(3)).toBe(0);
  const before = new Uint8Array(f.memory.buffer).slice();
  expect(f.readlink(3, 128, 4, 512, 32, f.memory.buffer.byteLength)).toBe(21);
  expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  expect(f.fs.readlinks).toBe(0);
});

function resizableMemory() {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 8 });
  if (!("toResizableBuffer" in memory) || typeof memory.toResizableBuffer !== "function")
    throw new Error("resizable WebAssembly memory unavailable");
  memory.toResizableBuffer();
  return memory;
}

test("D4 copies resizable guest UTF-8 byte prefixes with bounded fixed scratch", () => {
  const f = fixture(undefined, resizableMemory());
  const target = encoder.encode(f.target);
  const tree = snapshotNode(f.fs.root);
  for (let capacity = 0; capacity <= target.length + 2; capacity++) {
    const bytes = new Uint8Array(f.memory.buffer);
    bytes.fill(0xcc, 256, 260);
    bytes.fill(0xcc, 512, 544);
    const encoding = spyOn(TextEncoder.prototype, "encode");
    const direct = spyOn(TextEncoder.prototype, "encodeInto");
    try {
      expect(f.readlink(3, 128, 4, 512, capacity, 256)).toBe(0);
      const count = Math.min(capacity, target.length);
      expect(new DataView(f.memory.buffer).getUint32(256, true)).toBe(count);
      expect(bytes.slice(512, 512 + count)).toEqual(target.slice(0, count));
      expect(bytes.slice(512 + count, 544)).toEqual(new Uint8Array(32 - count).fill(0xcc));
      expect(encoding.mock.calls.every(([input]) => (input?.length ?? 0) <= 2)).toBe(true);
      expect(direct.mock.calls.length > 0).toBe(capacity > 0);
      expect(
        direct.mock.calls.every(
          ([input, output]) =>
            input.length <= 1025 &&
            output instanceof Uint8Array &&
            output.byteLength <= 1024 &&
            !("resizable" in output.buffer && output.buffer.resizable),
        ),
      ).toBe(true);
    } finally {
      encoding.mockRestore();
      direct.mockRestore();
    }
  }
  expect(f.fs.stats).toBe(0);
  expect(snapshotNode(f.fs.root)).toEqual(tree);
  expect(f.diagnostics).toEqual([]);
});

test.each([
  { name: "ASCII then pair", target: "a".repeat(1023) + "🙂é雪" + "z".repeat(2100) },
  { name: "two-byte then pair", target: "é".repeat(511) + "🙂".repeat(900) },
  { name: "three-byte then pair", target: "雪".repeat(341) + "🙂".repeat(1100) },
  { name: "pair at lookahead", target: "a".repeat(1024) + "🙂".repeat(1100) },
  { name: "unpaired surrogates", target: "a".repeat(1023) + "\ud800x\udc00" + "雪".repeat(1100) },
])("D4 preserves raw bytes across scratch boundaries: $name", ({ target }) => {
  const f = fixture(target, resizableMemory());
  const expected = encoder.encode(target);
  const encoding = spyOn(TextEncoder.prototype, "encode");
  const direct = spyOn(TextEncoder.prototype, "encodeInto");
  stops.push(
    () => encoding.mockRestore(),
    () => direct.mockRestore(),
  );
  const capacities = [
    0,
    1,
    2,
    3,
    1022,
    1023,
    1024,
    1025,
    2047,
    expected.length,
    expected.length + 3,
  ];
  for (const capacity of capacities) {
    const bytes = new Uint8Array(f.memory.buffer);
    bytes.fill(0xcc, 4095, 4096 + capacity + 1);
    expect(f.readlink(3, 128, 4, 4096, capacity, 256)).toBe(0);
    const count = Math.min(capacity, expected.length);
    expect(new DataView(f.memory.buffer).getUint32(256, true)).toBe(count);
    expect(bytes.slice(4096, 4096 + count)).toEqual(expected.slice(0, count));
    expect(bytes[4095]).toBe(0xcc);
    expect(bytes.slice(4096 + count, 4096 + capacity + 1)).toEqual(
      new Uint8Array(capacity - count + 1).fill(0xcc),
    );
  }
  expect(encoding.mock.calls.every(([input]) => (input?.length ?? 0) <= 2)).toBe(true);
  expect(
    direct.mock.calls.every(([input, output]) => input.length <= 1025 && output.byteLength <= 1024),
  ).toBe(true);
  expect(f.diagnostics).toEqual([]);
});

test("D4 bounds encoding for a large target and tiny resizable output", () => {
  const f = fixture("🙂é雪".repeat(20_000), resizableMemory());
  const encoding = spyOn(TextEncoder.prototype, "encode");
  const direct = spyOn(TextEncoder.prototype, "encodeInto");
  stops.push(
    () => encoding.mockRestore(),
    () => direct.mockRestore(),
  );
  expect(f.readlink(3, 128, 4, 512, 3, 256)).toBe(0);
  expect(new Uint8Array(f.memory.buffer).slice(512, 515)).toEqual(
    new Uint8Array([0xf0, 0x9f, 0x99]),
  );
  expect(encoding.mock.calls.every(([input]) => (input?.length ?? 0) <= 2)).toBe(true);
  expect(
    direct.mock.calls.every(([input, output]) => input.length <= 4 && output.byteLength <= 3),
  ).toBe(true);
});

test("D4 zero capacity accepts the exact memory end and still validates used", () => {
  const f = fixture();
  new Uint8Array(f.memory.buffer).fill(0xcc, 256, 260);
  expect(f.readlink(3, 128, 4, f.memory.buffer.byteLength, 0, 256)).toBe(0);
  expect(new DataView(f.memory.buffer).getUint32(256, true)).toBe(0);
  expect(f.fs.readlinks).toBe(1);
});

test("D4 memory faults precede rights denial on resizable guest memory", () => {
  const f = fixture(undefined, resizableMemory());
  const root = f.wasi.descriptors.get(3);
  if (!root) throw new Error("missing preopen");
  root.rightsBase &= ~RIGHT_PATH_READLINK;
  const before = new Uint8Array(f.memory.buffer).slice();
  expect(f.readlink(3, 128, 4, 512, 32, f.memory.buffer.byteLength)).toBe(21);
  expect(f.readlink()).toBe(76);
  expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  expect(f.fs.readlinks).toBe(0);
});

test("D4 reacquires resizable output after the host replaces its memory buffer", () => {
  const f = fixture("raw é/雪/🙂 target", resizableMemory());
  const before = f.memory.buffer;
  f.fs.onReadlink = () => {
    f.memory.grow(1);
    if (!("toFixedLengthBuffer" in f.memory) || typeof f.memory.toFixedLengthBuffer !== "function")
      throw new Error("fixed WebAssembly memory unavailable");
    f.memory.toFixedLengthBuffer();
  };
  expect(f.readlink()).toBe(0);
  expect(f.memory.buffer).not.toBe(before);
  const expected = encoder.encode(f.target);
  expect(new DataView(f.memory.buffer).getUint32(256, true)).toBe(expected.length);
  expect(new Uint8Array(f.memory.buffer).slice(512, 512 + expected.length)).toEqual(expected);
  expect(f.diagnostics).toEqual([]);
});

test("D4 acquires current output views after an ordinary host memory growth", () => {
  const f = fixture("raw target");
  f.fs.onReadlink = () => {
    f.memory.grow(1);
  };
  expect(f.readlink()).toBe(0);
  expect(new DataView(f.memory.buffer).getUint32(256, true)).toBe(10);
  expect(new Uint8Array(f.memory.buffer).slice(512, 522)).toEqual(encoder.encode("raw target"));
});

test.each([
  { path: "ordinary.txt", errno: 28 },
  { path: "directory", errno: 28 },
  { path: "missing", errno: 44 },
  { path: "link/", errno: 54 },
])("D4 valid-memory path failure preserves output and namespace %j", ({ path, errno }) => {
  const f = fixture();
  const len = f.put(path);
  const before = new Uint8Array(f.memory.buffer).slice();
  const tree = snapshotNode(f.fs.root);
  expect(f.readlink(3, 128, len)).toBe(errno);
  expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  expect(snapshotNode(f.fs.root)).toEqual(tree);
  expect(f.diagnostics).toEqual([]);
});

test("D4 rights denial and closed descriptor do not read or change output", () => {
  const f = fixture();
  const root = f.wasi.descriptors.get(3);
  if (!root) throw new Error("missing preopen");
  root.rightsBase &= ~RIGHT_PATH_READLINK;
  const before = new Uint8Array(f.memory.buffer).slice();
  expect(f.readlink()).toBe(76);
  expect(guestFunction(f.instance, "fd_close")(3)).toBe(0);
  expect(f.readlink()).toBe(8);
  expect(new Uint8Array(f.memory.buffer)).toEqual(before);
  expect(f.fs.readlinks).toBe(0);
});

class PinnedBackend extends MemoryBackend {
  readonly pins = new Map<number, number>();
  retain(handle: number): void {
    super.retain(handle);
    this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1);
  }
  release(handle: number): void {
    super.release(handle);
    const count = this.pins.get(handle);
    if (!count) throw new Error("unbalanced backend release");
    if (count === 1) this.pins.delete(handle);
    else this.pins.set(handle, count - 1);
  }
}
function serviceFixture() {
  const fs = new MemFS();
  fs.writeFile("/ordinary.txt", "unchanged text");
  link(fs, "/link", "../raw//é/雪/🙂");
  const backend = new PinnedBackend(fs);
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  const peer = createFilesystemConnection(connection.client);
  const client = new FilesystemClient(connection.client);
  const sibling = new FilesystemClient(peer.client);
  stops.push(() => {
    client.dispose();
    sibling.dispose();
    service.dispose();
  });
  service.connect(connection.server);
  service.connect(peer.server);
  return { fs, backend, service, client, sibling };
}
async function remoteHandle(client: FilesystemClient, path: string): Promise<number> {
  const root: unknown = await client.asyncCall("preopen", ["/"]);
  const edge: unknown = await client.asyncCall("resolve", [root, path]);
  if (
    typeof edge !== "object" ||
    edge === null ||
    !("node" in edge) ||
    typeof edge.node !== "number"
  )
    throw new Error("missing remote node");
  return edge.node;
}

async function rejectedReadlink(client: FilesystemClient, handle: number, errno: number) {
  const completion = client.submit("readlink", [handle]);
  try {
    let failure: unknown;
    try {
      await completion.value();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ errno });
  } finally {
    completion.release();
  }
}

test("N5 existing explicit pins preserve a raw link through rename, unlink and name reuse", async () => {
  const f = serviceFixture();
  const handle = await remoteHandle(f.client, "link");
  f.client.retain(handle);
  const stat = f.client.stat(handle);
  const target: unknown = await f.client.asyncCall("readlink", [handle]);
  expect(target).toBe("../raw//é/雪/🙂");
  expect(await f.sibling.asyncCall("move", ["/link", "/moved"])).toBe(0);
  expect(await f.sibling.asyncCall("remove", ["/moved"])).toBe(true);
  link(f.fs, "/link", "ordinary.txt");
  const beforeRead = snapshotNode(f.fs.root);
  expect(await f.client.asyncCall("readlink", [handle])).toBe(target);
  expect(f.client.stat(handle)).toEqual({ ...stat, nlink: 0 });
  expect(snapshotNode(f.fs.root)).toEqual(beforeRead);
  expect(f.backend.pins.has(handle)).toBe(true);
  f.client.release(handle);
  await f.client.asyncCall("listFiles", ["/"]);
  expect(f.backend.pins.has(handle)).toBe(false);
  await rejectedReadlink(f.client, handle, 8);
  expect(() => f.client.retain(handle)).toThrow(new FilesystemError(8));
  expect(() => f.client.release(handle)).toThrow(new FilesystemError(8));
  expect(snapshotNode(f.fs.root)).toEqual(beforeRead);
  expect(new TextDecoder().decode(f.fs.readFile("/ordinary.txt"))).toBe("unchanged text");
  f.client.dispose();
  f.sibling.dispose();
  f.service.dispose();
  expect(f.backend.pins.size).toBe(0);
  expect(f.service.resources()).toMatchObject({ clients: 0, retained: 0, responses: 0 });
});

test("N5 existing transient results are not leases after sibling unlink", async () => {
  const f = serviceFixture();
  const handle = await remoteHandle(f.client, "link");
  expect(await f.sibling.asyncCall("remove", ["/link"])).toBe(true);
  const tree = snapshotNode(f.fs.root);
  await rejectedReadlink(f.client, handle, 8);
  expect(() => f.client.retain(handle)).toThrow(new FilesystemError(8));
  expect(f.backend.pins.has(handle)).toBe(false);
  expect(snapshotNode(f.fs.root)).toEqual(tree);
});

test("N5 service readlink preserves wrong-kind and foreign-handle errors", async () => {
  const f = serviceFixture();
  const file = await remoteHandle(f.client, "ordinary.txt");
  const linkHandle = await remoteHandle(f.client, "link");
  const tree = snapshotNode(f.fs.root);
  await rejectedReadlink(f.client, file, 28);
  await rejectedReadlink(f.sibling, linkHandle, 8);
  expect(snapshotNode(f.fs.root)).toEqual(tree);
});
