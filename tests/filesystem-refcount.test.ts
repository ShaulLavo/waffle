import { SLOT_WORDS } from "../fs/shared.js";
import { readFileSync } from "node:fs";
import * as protocol from "../fs/protocol.ts";
import * as shared from "../fs/shared.ts";
import * as native from "../proc/intrinsics.ts";
import { localPublication } from "../fs/publication-internal.ts";
import { mutationIntent } from "../fs/publication.ts";
import { CAPABILITY_HEADER, CAPABILITY_WORDS } from "../fs/protocol";
import { afterEach, expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemError,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
  reapFilesystem,
  revokeFilesystem,
  type FilesystemConnection,
} from "../fs";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const encode = (value: string) => new TextEncoder().encode(value);
class TrackingBackend extends MemoryBackend {
  readonly pins = new Map<number, number>();
  retain(handle: number): void {
    super.retain(handle);
    this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1);
  }
  release(handle: number): void {
    super.release(handle);
    const count = this.pins.get(handle)!;
    if (count === 1) this.pins.delete(handle);
    else this.pins.set(handle, count - 1);
  }
}
/** Interleave the actual client at its captured CAS, without replacing production globals. */
function isolatedClient() {
  const hooks = { compareExchange: native.atomicsCompareExchange };
  const bindings = {
    localPublication,
    mutationIntent,
    ...protocol,
    ...shared,
    ...native,
    atomicsCompareExchange: ((...args: unknown[]) =>
      Reflect.apply(
        hooks.compareExchange,
        undefined,
        args,
      )) as typeof native.atomicsCompareExchange,
  };
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(new URL("../fs/client.ts", import.meta.url), "utf8")
      .replace(/^import\b[^;]*;\n/gm, "")
      .replace(/^export /gm, "")
      .concat("\nreturn FilesystemClient;\n"),
  );
  const names = Object.keys(bindings);
  const Client = new Function(...names.concat([source]))(
    ...names.map((name) => bindings[name as keyof typeof bindings]),
  ) as typeof FilesystemClient;
  return { hooks, Client };
}
function fixture(Client = FilesystemClient) {
  const backend = new TrackingBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new Client(connection.client);
  cleanups.push(() => {
    client.dispose();
    service.dispose();
  });
  // A regression must fail rather than block the same-thread service on the old sync RPC.
  const call = client.call.bind(client);
  client.call = (...args) => {
    if (args[0] === "retain" || args[0] === "release")
      throw new Error(`unexpected reference RPC: ${args[0]}`);
    return call(...args);
  };
  return { backend, service, client };
}
async function file(client: FilesystemClient) {
  await client.asyncCall("writeFile", ["/shared"], encode("original"));
  const root = await client.asyncCall("preopen", ["/"]);
  const path = await client.asyncCall("resolve", [root, "shared"]);
  return { root, path, handle: path.node as number };
}
function worker(connection: FilesystemConnection, scenario: string) {
  const guest = new Worker(
    new URL("./fixtures/filesystem-refcount-guest.ts", import.meta.url).href,
  );
  cleanups.push(() => {
    guest.terminate();
    reapFilesystem(connection);
  });
  const result = nextMessage(guest);
  guest.postMessage({ connection, scenario }, [connection.port]);
  return { guest, result };
}
function nextMessage(guest: Worker): Promise<any> {
  return new Promise((resolve, reject) => {
    guest.onmessage = ({ data }) => resolve(data);
    guest.onerror = reject;
  });
}
function table(connection: FilesystemConnection): Int32Array {
  const buffer = (connection as FilesystemConnection & { capabilities: SharedArrayBuffer })
    .capabilities;
  expect(buffer).toBeInstanceOf(SharedArrayBuffer);
  return new Int32Array(buffer);
}
function refIndex(cells: Int32Array, handle: number): number {
  for (let key = CAPABILITY_HEADER; key < cells.length; key += CAPABILITY_WORDS)
    if (Atomics.load(cells, key) === handle && Atomics.load(cells, key + 1) >= 0) return key + 1;
  throw new Error(`missing capability ${handle}`);
}

function forbidStatRPC(client: FilesystemClient): void {
  const submit = client.submit.bind(client);
  client.submit = (...args) => {
    if (args[0] === "stat") throw new Error("unexpected stat RPC");
    return submit(...args);
  };
}

test("transient stat reads shared metadata without a service request or leaked reference", async () => {
  const { client, backend } = fixture();
  const { root, handle } = await file(client);
  const expected = await client.asyncCall("stat", [handle]);
  const cells = table(client.connection);
  const index = refIndex(cells, handle);
  const pins = backend.pins.get(handle);
  forbidStatRPC(client);
  expect(client.stat(handle)).toEqual(expected);
  expect(client.stat(root)).toMatchObject({ kind: "directory", size: 0 });
  expect(Atomics.load(cells, index)).toBe(0);
  expect(backend.pins.get(handle)).toBe(pins);
});

test("transient stat stays fresh across sibling writes and returns independent snapshots", async () => {
  const { client } = fixture();
  const { handle } = await file(client);
  const sibling = new FilesystemClient(client.fork());
  cleanups.push(() => sibling.dispose());
  const root = await sibling.asyncCall("preopen", ["/"]);
  const path = await sibling.asyncCall("resolve", [root, "shared"]);
  forbidStatRPC(client);
  const before = client.stat(handle);
  before.size = 999;
  expect(client.stat(handle).size).toBe(8);
  await sibling.asyncCall("write", [path.node, 0], encode("longer replacement"));
  await sibling.asyncCall("setMtime", [path.node, 12345]);
  expect(client.stat(handle)).toMatchObject({ ino: before.ino, size: 18, mtime: 12345 });
  await sibling.asyncCall("resize", [path.node, 3, true]);
  expect(client.stat(handle)).toMatchObject({ ino: before.ino, size: 3 });
});

for (const opened of [false, true])
  test(`shared stat releases its temporary reference after failure with opened=${opened}`, async () => {
    const { client } = fixture();
    const { handle } = await file(client);
    if (opened) client.retain(handle);
    const cells = table(client.connection);
    const index = refIndex(cells, handle);
    const references = Atomics.load(cells, index);
    const failure = new FilesystemError(29);
    client.shared.stat = () => {
      expect(Atomics.load(cells, index)).toBe(references + 1);
      throw failure;
    };
    forbidStatRPC(client);
    let caught: unknown;
    try {
      client.stat(handle);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(Atomics.load(cells, index)).toBe(references);
    if (opened) client.release(handle);
  });

test("a transient stat keeps its capability alive through service eviction and rejects it after reuse", async () => {
  const { client, service, backend } = fixture();
  const { root, handle } = await file(client);
  client.retain(handle);
  const handles: number[] = [];
  for (let i = 0; i < 257; i++) {
    await client.asyncCall("writeFile", [`/stat-pressure-${i}`], new Uint8Array());
    const path = await client.asyncCall("resolve", [root, `stat-pressure-${i}`]);
    client.retain(path.node);
    handles.push(path.node);
  }
  client.release(handle);
  for (const opened of handles) client.release(opened);
  const cells = table(client.connection);
  const index = refIndex(cells, handle);
  const peer = createFilesystemConnection(client.connection);
  cleanups.push(() => peer.client.port.close());
  const stat = client.shared.stat.bind(client.shared);
  client.shared.stat = (...args) => {
    expect(Atomics.load(cells, index)).toBe(1);
    service.connect(peer.server);
    expect(backend.pins.has(handle)).toBe(true);
    return stat(...args);
  };
  forbidStatRPC(client);
  expect(client.stat(handle)).toMatchObject({ kind: "file", size: 8 });
  expect(Atomics.load(cells, index)).toBe(0);
  client.shared.stat = stat;
  await client.asyncCall("listFiles", ["/"]);
  expect(backend.pins.has(handle)).toBe(false);
  expect(() => client.stat(handle)).toThrow(new FilesystemError(8));
  const replacement = await client.asyncCall("resolve", [root, "stat-pressure-0"]);
  expect(client.stat(replacement.node)).toMatchObject({ size: 0 });
  expect(() => client.stat(handle)).toThrow(new FilesystemError(8));
});

test("stat releases its temporary reference when a missing shared slot reaches a failed service call", async () => {
  const { client } = fixture();
  const { handle } = await file(client);
  const cells = table(client.connection);
  const index = refIndex(cells, handle);
  const failure = new FilesystemError(29);
  client.shared.stat = () => undefined;
  client.submit = () => {
    expect(Atomics.load(cells, index)).toBe(1);
    throw failure;
  };
  let caught: unknown;
  try {
    client.stat(handle);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(Atomics.load(cells, index)).toBe(0);
});

test("shared stat preserves an open unlinked identity through name reuse and rejects its last close", async () => {
  const { client, backend } = fixture();
  const { root, handle } = await file(client);
  client.retain(handle);
  forbidStatRPC(client);
  const original = client.stat(handle);
  await client.asyncCall("remove", ["/shared"]);
  await client.asyncCall("writeFile", ["/shared"], encode("new"));
  const replacement = await client.asyncCall("resolve", [root, "shared"]);
  expect(client.stat(handle)).toEqual(original);
  expect(client.stat(replacement.node)).toMatchObject({ size: 3 });
  expect(client.stat(replacement.node).ino).not.toBe(original.ino);
  client.release(handle);
  await client.asyncCall("listFiles", ["/"]);
  expect(backend.shared.hasFile(handle)).toBe(false);
  expect(() => client.stat(handle)).toThrow(new FilesystemError(8));
});

test("shared stat rejects invalid and foreign capabilities even when their metadata is resident", async () => {
  const { client, backend } = fixture();
  const sibling = new FilesystemClient(client.fork());
  cleanups.push(() => sibling.dispose());
  const { handle } = await file(sibling);
  expect(backend.shared.stat(handle)).toBeDefined();
  forbidStatRPC(client);
  expect(() => client.stat(handle)).toThrow(new FilesystemError(8));
  expect(() => client.stat(-1)).toThrow(new FilesystemError(8));
  expect(() => client.stat(0.5)).toThrow(new FilesystemError(8));
});

test("revocation during shared stat lock contention releases the temporary reference and backend pin", async () => {
  const { client, service, backend } = fixture();
  const { handle } = await file(client);
  const lock = client.shared.fileSlot(handle) * SLOT_WORDS + 8;
  Atomics.store(client.shared.slots, lock, 42);
  client.shared.onContention = () => {
    revokeFilesystem(client.connection);
    Atomics.store(client.shared.slots, lock, 0);
  };
  forbidStatRPC(client);
  expect(() => client.stat(handle)).toThrow(new FilesystemError(11));
  expect(Atomics.load(client.shared.slots, lock)).toBe(0);
  reapFilesystem(client.connection);
  service.sweep();
  expect(backend.pins.size).toBe(0);
  expect(() => client.stat(handle)).toThrow(new FilesystemError(11));
});

test("cached WASI path_open and close send no retain/release or other RPC", async () => {
  const { client } = fixture();
  await client.asyncCall("writeFile", ["/shared"], encode("original"));
  const { result } = worker(client.fork(), "hot");
  expect(await result).toEqual({
    operations: [],
    errors: Array.from({ length: 40 }, () => 0),
    stderr: [],
  });
});

test("readdir caches the response epoch, not a later sibling mutation epoch", async () => {
  const { client } = fixture();
  const { result } = worker(client.fork(), "readdir");
  const entries = await result;
  expect(entries.before).not.toContain("after");
  expect(entries.after).toContain("after");
});

test("separate opens of one unlinked file survive one close and transient eviction", async () => {
  const { client, service, backend } = fixture();
  const { root, path, handle } = await file(client);
  client.retain(handle);
  client.retain(handle);
  client.release(handle);
  expect(await client.asyncCall("removePath", [path, false])).toBe(0);
  for (let i = 0; i < 300; i++) {
    await client.asyncCall("writeFile", [`/other-${i}`], new Uint8Array());
    await client.asyncCall("resolve", [root, `other-${i}`]);
  }
  expect(backend.pins.get(handle)).toBe(1);
  const bytes = new Uint8Array(8);
  expect(client.read(handle, [bytes], 0)).toBe(8);
  expect(new TextDecoder().decode(bytes)).toBe("original");
  expect(service.resources().transient).toBeLessThanOrEqual(256);
  client.release(handle);
  await client.asyncCall("listFiles", ["/"]);
  expect(backend.pins.has(handle)).toBe(false);
  expect(backend.shared.hasFile(handle)).toBe(false);
});

test("RPC and local reference ownership cannot release each other's open", async () => {
  const { client, backend } = fixture();
  const { handle } = await file(client);
  await client.asyncCall("retain", [handle]);
  client.retain(handle);
  await client.asyncCall("release", [handle]);
  expect(backend.pins.get(handle)).toBe(1);
  expect(await client.asyncCall("release", [handle]).catch((error) => error)).toMatchObject({
    errno: 8,
  });
  const bytes = new Uint8Array(8);
  expect(client.read(handle, [bytes], 0)).toBe(8);
  client.release(handle);
  await client.asyncCall("retain", [handle]);
  await client.asyncCall("release", [handle]);
  expect(backend.pins.has(handle)).toBe(false);
});

test("a retain winning exactly at trim's CAS prevents eviction", async () => {
  const { client, backend } = fixture();
  const { root, handle } = await file(client);
  for (let i = 0; i < 256; i++)
    await client.asyncCall("writeFile", [`/other-${i}`], new Uint8Array());
  for (let i = 0; i < 255; i++) await client.asyncCall("resolve", [root, `other-${i}`]);
  const cells = table(client.connection);
  const index = refIndex(cells, handle);
  const compareExchange = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = ((
    array: Int32Array,
    at: number,
    expected: number,
    replacement: number,
  ) => {
    if (
      !raced &&
      array.buffer === cells.buffer &&
      at === index &&
      expected === 0 &&
      replacement === -1
    ) {
      raced = true;
      client.retain(handle);
    }
    return compareExchange(array, at, expected, replacement);
  }) as typeof Atomics.compareExchange;
  try {
    await client.asyncCall("resolve", [root, "other-255"]);
  } finally {
    Atomics.compareExchange = compareExchange;
  }
  expect(raced).toBe(true);
  expect(Atomics.load(cells, index)).toBe(1);
  expect(backend.pins.get(handle)).toBe(1);
  client.release(handle);
});

test("reused capability entries cannot make a stale retain acquire a different handle", async () => {
  const { hooks, Client } = isolatedClient();
  const { client } = fixture(Client);
  const { handle } = await file(client);
  const cells = table(client.connection);
  const index = refIndex(cells, handle);
  const compareExchange = hooks.compareExchange;
  let raced = false;
  hooks.compareExchange = ((
    array: Int32Array,
    at: number,
    expected: number,
    replacement: number,
  ) => {
    if (
      !raced &&
      array.buffer === cells.buffer &&
      at === index &&
      expected === 0 &&
      replacement === 1
    ) {
      raced = true;
      expect(compareExchange(cells, index, 0, -1)).toBe(0);
      Atomics.store(cells, index - 1, handle + 100000);
      Atomics.store(cells, index, 0);
    }
    return compareExchange(array, at, expected, replacement);
  }) as typeof hooks.compareExchange;
  try {
    expect(() => client.retain(handle)).toThrow();
    expect(raced).toBe(true);
    expect(Atomics.load(cells, index)).toBe(0);
  } finally {
    hooks.compareExchange = compareExchange;
    Atomics.store(cells, index - 1, handle);
    Atomics.store(cells, index, 0);
  }
});

test("closing a local open after revocation is a no-op, not a cancelled RPC", async () => {
  const { client, service, backend } = fixture();
  const { handle } = await file(client);
  client.retain(handle);
  revokeFilesystem(client.connection);
  expect(() => client.release(handle)).not.toThrow();
  reapFilesystem(client.connection);
  service.sweep();
  expect(backend.pins.size).toBe(0);
});

test("killing a guest with held local references releases its one backend pin", async () => {
  const { client, service, backend } = fixture();
  await client.asyncCall("writeFile", ["/shared"], encode("original"));
  const connection = client.fork();
  const { guest, result } = worker(connection, "held");
  const { handle } = await result;
  expect(backend.pins.get(handle)).toBe(1);
  await client.asyncCall("remove", ["/shared"]);
  const stopped = nextMessage(guest);
  revokeFilesystem(connection);
  guest.postMessage({ scenario: "stat" });
  expect(await stopped).toEqual({ errno: 11 });
  guest.terminate();
  reapFilesystem(connection);
  service.sweep();
  expect(backend.pins.has(handle)).toBe(false);
  expect(backend.shared.hasFile(handle)).toBe(false);
});

test("the last local close frees an unlinked file below the transient budget", async () => {
  const { client, backend } = fixture();
  const { handle, path } = await file(client);
  client.retain(handle);
  expect(await client.asyncCall("removePath", [path, false])).toBe(0);
  expect(backend.shared.resources().usedBytes).toBeGreaterThan(0);
  client.release(handle);
  await client.asyncCall("listFiles", ["/"]);
  expect(backend.shared.resources().usedBytes).toBe(0);
  expect(backend.pins.has(handle)).toBe(false);
});

test("unlink frees idle cached capabilities in sibling sessions", async () => {
  const { client, service, backend } = fixture();
  const { handle } = await file(client);
  const sibling = new FilesystemClient(client.fork());
  cleanups.push(() => sibling.dispose());
  const root = await sibling.asyncCall("preopen", ["/"]);
  await sibling.asyncCall("resolve", [root, "shared"]);
  client.retain(handle);
  client.release(handle);
  expect(backend.pins.get(handle)).toBe(2);
  await sibling.asyncCall("remove", ["/shared"]);
  expect(backend.shared.resources().usedBytes).toBe(0);
  expect(backend.pins.has(handle)).toBe(false);
  expect(service.resources().transient).toBe(0);
});

test("in-capacity append and zero-byte positioned writes make no service calls", async () => {
  const { client } = fixture();
  const { handle } = await file(client);
  client.retain(handle);
  expect(client.setMtime(handle, 123)).toBe(0);
  client.call = () => {
    throw new Error("unexpected direct IO RPC");
  };
  expect(client.write(handle, [new Uint8Array()], 0x10000000)).toBe(0);
  expect(client.append(handle, [new Uint8Array()])).toEqual({ written: 0, offset: 8 });
  expect(client.stat(handle).mtime).toBe(123);
  expect(client.append(handle, [encode("a"), encode("b")])).toEqual({ written: 2, offset: 10 });
  const bytes = new Uint8Array(10);
  expect(client.read(handle, [bytes], 0)).toBe(10);
  expect(new TextDecoder().decode(bytes)).toBe("originalab");
  client.release(handle);
});

test("more than 256 active opens do not evict the next returned capability", async () => {
  const { client, service } = fixture();
  const root = await client.asyncCall("preopen", ["/"]);
  const handles: number[] = [];
  for (let i = 0; i < 301; i++) {
    await client.asyncCall("writeFile", [`/active-${i}`], new Uint8Array());
    const path = await client.asyncCall("resolve", [root, `active-${i}`]);
    client.retain(path.node);
    handles.push(path.node);
  }
  expect(service.resources().transient).toBe(0);
  for (const handle of handles) client.release(handle);
  await client.asyncCall("listFiles", ["/"]);
  expect(service.resources().transient).toBeLessThanOrEqual(256);
});

test("service memory accounting enumerates capability table metadata", () => {
  const { backend, client, service } = fixture();
  const cells = table(client.connection);
  const resources = { ...service.resources() };
  expect(resources.capabilityBytes).toBe(cells.byteLength);
  expect(resources.metadataBytes).toBeGreaterThanOrEqual(cells.byteLength);
  const backendResources = backend.shared.resources();
  expect(resources.bytes).toBe(
    backendResources.bytes + resources.ownerStateBytes + resources.capabilityBytes,
  );
  expect(resources.metadataBytes).toBe(
    backendResources.metadataBytes + resources.ownerStateBytes + resources.capabilityBytes,
  );
});
