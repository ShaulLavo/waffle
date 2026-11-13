import { afterEach, expect, test } from "bun:test";
import { retainedClientFixture } from "./fixtures/retained-client.js";
import { FilesystemError, revokeFilesystem } from "../fs/protocol.js";
import { FilesystemClient, createFilesystemConnection } from "../fs/index.js";
import type { ResolvedPath } from "../core/filesystem.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

function expectErrno(action: () => unknown, errno: number): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(FilesystemError);
  expect(failure).toMatchObject({ errno });
}

test("non-link shared metadata returns EINVAL without a service request or retained reference", () => {
  const { client, cleanup } = retainedClientFixture();
  const before = Array.from(new Int32Array(client.connection.capabilities));
  let calls = 0;
  client.call = () => {
    calls++;
    throw new FilesystemError(28);
  };
  try {
    for (let index = 0; index < 10; index++) {
      expectErrno(() => client.readlink(0), 28);
    }
    expect(calls).toBe(0);
    expect(Array.from(new Int32Array(client.connection.capabilities))).toEqual(before);
  } finally {
    cleanup();
  }
});

test("missing shared metadata keeps the service fallback and releases its pin on failure", () => {
  const { client, cleanup } = retainedClientFixture();
  const before = Array.from(new Int32Array(client.connection.capabilities));
  client.shared.stat = () => undefined;
  let calls = 0;
  client.call = (operation) => {
    expect(operation).toBe("readlink");
    calls++;
    throw new FilesystemError(28);
  };
  try {
    expectErrno(() => client.readlink(0), 28);
    expect(calls).toBe(1);
    expect(Array.from(new Int32Array(client.connection.capabilities))).toEqual(before);
  } finally {
    cleanup();
  }
});

test("symlink metadata keeps target bytes and the existing service path", () => {
  const { client, cleanup } = retainedClientFixture();
  const stat = client.shared.stat.bind(client.shared);
  client.shared.stat = (...args) => {
    const value = stat(...args);
    return value && { ...value, kind: "symlink" };
  };
  const target = "../raw//é/雪/🙂";
  client.call = (operation) => {
    expect(operation).toBe("readlink");
    return target;
  };
  const before = Array.from(new Int32Array(client.connection.capabilities));
  try {
    expect(client.readlink(0)).toBe(target);
    expect(Array.from(new Int32Array(client.connection.capabilities))).toEqual(before);
  } finally {
    cleanup();
  }
});

test("invalid handles fail through capability validation before shared metadata", () => {
  const { client, cleanup } = retainedClientFixture();
  client.shared.stat = () => {
    throw new Error("invalid handle reached shared metadata");
  };
  const before = Array.from(new Int32Array(client.connection.capabilities));
  try {
    expectErrno(() => client.readlink(999999), 8);
    expect(Array.from(new Int32Array(client.connection.capabilities))).toEqual(before);
  } finally {
    cleanup();
  }
});

test("shared-stat errors preserve their errno and release the temporary pin", () => {
  const { client, cleanup } = retainedClientFixture();
  const before = Array.from(new Int32Array(client.connection.capabilities));
  client.shared.stat = () => {
    throw new FilesystemError(11);
  };
  try {
    expectErrno(() => client.readlink(0), 11);
    expect(Array.from(new Int32Array(client.connection.capabilities))).toEqual(before);
  } finally {
    cleanup();
  }
});

test("publication shared metadata uses its current-state lock and releases it on EINVAL", () => {
  const limits = {
    sessions: 4,
    operations: 8,
    inputBytes: 64,
    argumentBytes: 512,
    effectBytes: 2048,
    effects: 16,
    resultBytes: 128,
    logRecords: 2,
    logBytes: 4096,
    pins: 2,
    pinBytes: 128,
  };
  const pair = createFilesystemConnection(undefined, { limits, observe: true });
  const client = new FilesystemClient(pair.client);
  client.shared.register(
    0,
    { kind: "file", ino: 1, nlink: 1, size: 1, mtime: 1 },
    new Uint8Array([1]),
  );
  const capabilities = new Int32Array(pair.client.capabilities);
  Atomics.store(capabilities, 1, 0);
  Atomics.store(capabilities, 2, 0);
  client.retain(0);
  let locks = 0;
  const current = client.shared.current.bind(client.shared);
  client.shared.current = (...args) => {
    locks++;
    return current(...args);
  };
  client.call = () => {
    throw new Error("publication fast path used RPC");
  };
  try {
    expectErrno(() => client.readlink(0), 28);
    expect(locks).toBe(1);
    expect(Atomics.load(client.shared.cells, 1)).toBe(0);
    expect(Atomics.load(capabilities, 2)).toBe(1);
  } finally {
    client.dispose();
    pair.server.port.close();
  }
});

test("resident clients bypass shared metadata and release their pin after RPC", () => {
  const { client, cleanup } = retainedClientFixture();
  const before = Array.from(new Int32Array(client.connection.capabilities));
  const target = "../raw//é/雪/🙂";
  client.shared.stat = () => {
    throw new Error("resident client consulted shared stat");
  };
  client.call = (operation) => {
    expect(operation).toBe("readlink");
    return target;
  };
  Reflect.set(client, "resident", {});
  try {
    expect(client.readlink(0)).toBe(target);
    expect(Array.from(new Int32Array(client.connection.capabilities))).toEqual(before);
    client.call = () => {
      throw new FilesystemError(2);
    };
    expectErrno(() => client.readlink(0), 2);
    expect(Array.from(new Int32Array(client.connection.capabilities))).toEqual(before);
  } finally {
    Reflect.set(client, "resident", undefined);
    cleanup();
  }
});

test.each(["revoked", "disposed"])("%s clients fail before shared metadata", (state) => {
  const { client, cleanup } = retainedClientFixture();
  client.shared.stat = () => {
    throw new Error("inactive client consulted shared stat");
  };
  try {
    if (state === "revoked") revokeFilesystem(client.connection);
    else client.dispose();
    expectErrno(() => client.readlink(0), 11);
  } finally {
    cleanup();
  }
});

async function serviceFixture() {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  const calls = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./fixtures/readlink-service.ts", import.meta.url).href);
  stops.push(() => {
    client.dispose();
    worker.terminate();
    pair.server.port.close();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("readlink service startup timed out")), 3000);
      worker.onmessage = () => resolve();
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ connection: pair.server, calls: calls.buffer }, [pair.server.port]);
    });
  } finally {
    clearTimeout(timer);
  }
  const root: number = await client.asyncCall("preopen", ["/"]);
  const path = (name: string): ResolvedPath => {
    const resolved = client.resolve(root, name);
    if (typeof resolved === "number") throw new FilesystemError(resolved);
    return resolved;
  };
  const handle = (name: string): number => {
    const node = path(name).node;
    if (node === undefined) throw new FilesystemError(44);
    return node;
  };
  return { client, calls, root, path, handle };
}

test("shared readlink saves RPCs while preserving service outcomes and target bytes", async () => {
  const f = await serviceFixture();
  f.client.writeFile("/file", "contents");
  const directory = f.client.create(f.path("directory"), "directory");
  expect(typeof directory).toBe("number");
  const target = "../raw//é/雪/🙂";
  expect(f.client.symlink(f.path("link"), target)).toBe(0);
  const file = f.handle("file");
  const dir = f.handle("directory");
  const link = f.handle("link");
  f.client.retain(file);
  f.client.retain(dir);
  f.client.retain(link);
  const before = Array.from(new Int32Array(f.client.connection.capabilities));
  for (let index = 0; index < 10; index++) {
    expectErrno(() => f.client.readlink(file), 28);
    expectErrno(() => f.client.readlink(dir), 28);
  }
  expect(Atomics.load(f.calls, 0)).toBe(0);
  expect(f.client.readlink(link)).toBe(target);
  expect(Atomics.load(f.calls, 0)).toBe(1);
  f.client.shared.stat = () => undefined;
  expectErrno(() => f.client.readlink(file), 28);
  expectErrno(() => f.client.readlink(dir), 28);
  expect(f.client.readlink(link)).toBe(target);
  expect(Atomics.load(f.calls, 0)).toBe(4);
  expect(Array.from(new Int32Array(f.client.connection.capabilities))).toEqual(before);
});

test("replacement and rename preserve pinned file and symlink identities", async () => {
  const f = await serviceFixture();
  f.client.writeFile("/change", "original");
  const oldFile = f.handle("change");
  f.client.retain(oldFile);
  expectErrno(() => f.client.readlink(oldFile), 28);
  expect(f.client.removePath(f.path("change"), false)).toBe(0);
  const target = "../raw//é/雪/🙂";
  expect(f.client.symlink(f.path("change"), target)).toBe(0);
  const oldLink = f.handle("change");
  f.client.retain(oldLink);
  expect(f.client.readlink(oldLink)).toBe(target);
  expectErrno(() => f.client.readlink(oldFile), 28);
  expect(f.client.rename(f.path("change"), f.path("renamed"))).toBe(0);
  expectErrno(() => f.handle("change"), 44);
  expect(f.client.readlink(f.handle("renamed"))).toBe(target);
  expect(f.client.removePath(f.path("renamed"), false)).toBe(0);
  f.client.writeFile("/change", "replacement");
  const replacement = f.handle("change");
  expect(replacement).not.toBe(oldFile);
  expect(replacement).not.toBe(oldLink);
  expectErrno(() => f.client.readlink(replacement), 28);
  expect(f.client.readlink(oldLink)).toBe(target);
  expectErrno(() => f.client.readlink(oldFile), 28);
  expect(Atomics.load(f.calls, 0)).toBe(3);
  f.client.release(oldFile);
  f.client.release(oldLink);
});

test("permission mutations and path errors still use current resolution", async () => {
  const f = await serviceFixture();
  f.client.writeFile("/parent/file", "private");
  const parent = f.handle("parent");
  const file = f.handle("parent/file");
  f.client.retain(file);
  expect(f.client.setMode(file, 0)).toBe(0);
  expectErrno(() => f.client.readlink(file), 28);
  expect(f.client.setMode(parent, 0)).toBe(0);
  expectErrno(() => f.handle("parent/file"), 2);
  expectErrno(() => f.client.readlink(file), 28);
  expect(f.client.setMode(parent, 0o700)).toBe(0);
  expectErrno(() => f.client.readlink(f.handle("parent//./file")), 28);
  expectErrno(() => f.handle("parent/file/"), 54);
  expectErrno(() => f.handle("parent/file/child"), 54);
  expectErrno(() => f.handle("missing"), 44);
  expectErrno(() => f.handle(""), 44);
  expect(Atomics.load(f.calls, 0)).toBe(0);
  f.client.release(file);
});
