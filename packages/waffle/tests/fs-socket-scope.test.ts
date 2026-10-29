import { afterEach, expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { MemFS } from "../fs/memory.js";
import {
  FILESYSTEM_SECTION_BYTES,
  connectFilesystemIdentity,
  createFilesystemConnection,
  createProcessFilesystemIdentity,
  revokeFilesystem,
  type FilesystemIdentity,
} from "../fs/protocol.js";
import { workspacePublication } from "../fs/workspace-protocol.js";
import type { SocketBinding } from "../core/filesystem.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
async function fixture(publication = false) {
  const fs = new MemFS();
  fs.mkdirp("/scope/child");
  fs.mkdirp("/outside");
  fs.writeFile("/scope/file", "data");
  const backend = new MemoryBackend(fs);
  const service = new FilesystemService(backend);
  cleanup.push(() => service.shutdown());
  const pair = createFilesystemConnection(
    undefined,
    publication ? { ...workspacePublication, observe: true } : undefined,
  );
  service.connect(pair.server);
  const guest = new FilesystemClient(pair.client);
  cleanup.push(() => guest.dispose());
  const root = await guest.asyncCall("preopen", ["/"]);
  const directory = await guest.asyncCall("resolve", [root, "scope"]);
  guest.retain(directory.node);
  return { fs, backend, service, guest, root, directory: directory.node as number };
}
async function attach(
  f: Awaited<ReturnType<typeof fixture>>,
  root = f.directory,
  identity: FilesystemIdentity = f.guest.connection,
) {
  const pair = connectFilesystemIdentity(createProcessFilesystemIdentity(identity));
  cleanup.push(() => {
    pair.client.port.close();
    pair.server.port.close();
  });
  const admitted = f.service.attachSocketScope(identity, root, pair.server);
  const client = new FilesystemClient(pair.client);
  client.adopt(admitted.reservation);
  cleanup.push(() => client.dispose());
  return { client, root: admitted.root, rootIno: admitted.rootIno };
}
async function bind(
  client: FilesystemClient,
  root: number,
  path = "/listener",
  lease = 1,
): Promise<SocketBinding> {
  const resolved = await client.asyncCall("resolve", [root, path, false]);
  expect(typeof resolved).not.toBe("number");
  const binding = await client.asyncCall("bindSocket", [resolved.parent, resolved.name, lease]);
  expect(binding).not.toHaveProperty("error");
  return binding;
}

test("ordinary guest sessions cannot nominate socket authority", async () => {
  const f = await fixture();
  for (const operation of ["bindSocket", "bindSocketPath", "unbindSocket", "connectSocket"]) {
    const error = await f.guest
      .asyncCall(operation, [f.directory, "listener", 1])
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ errno: 76 });
  }
  expect(f.fs.lookup("/scope/listener")).toBeUndefined();
});

test("scope admission authenticates actual sessions and live directory membership", async () => {
  const f = await fixture();
  const foreign = createFilesystemConnection();
  cleanup.push(() => {
    foreign.client.port.close();
    foreign.server.port.close();
  });
  await expect(attach(f, f.directory, foreign.client)).rejects.toMatchObject({ errno: 76 });
  const forged = {
    ...f.guest.connection,
    sections: new SharedArrayBuffer(FILESYSTEM_SECTION_BYTES),
  };
  await expect(attach(f, f.directory, forged)).rejects.toMatchObject({ errno: 76 });
  new Int32Array(forged.sections)[1] = -1;
  await expect(attach(f, f.directory, forged)).rejects.toMatchObject({ errno: 76 });
  const absent = f.fs.handleForNode(f.fs.lookup("/outside")!);
  await expect(attach(f, absent)).rejects.toMatchObject({ errno: 76 });
  const file = await f.guest.asyncCall("resolve", [f.root, "scope/file"]);
  await expect(attach(f, file.node)).rejects.toMatchObject({ errno: 76 });
  revokeFilesystem(f.guest.connection);
  await expect(attach(f)).rejects.toMatchObject({ errno: 11 });
});

test("only owner-admitted sessions can bind and normal methods cannot escape the scope", async () => {
  const f = await fixture();
  const a = await attach(f),
    b = await attach(f);
  const binding = await bind(a.client, a.root);
  expect(await b.client.asyncCall("connectSocket", [b.root, "/listener"])).toEqual({
    ino: binding.ino,
  });
  expect(b.rootIno).toBe(a.rootIno);
  expect(await b.client.asyncCall("resolve", [b.root, "../outside"])).toBe(76);
  await expect(a.client.asyncCall("preopen", ["/"])).rejects.toMatchObject({ errno: 76 });
  const denied = await b.client
    .asyncCall("unbindSocket", [binding, "listener", 1, true])
    .catch((error: unknown) => error);
  expect(denied).toMatchObject({ errno: 76 });
  expect(await a.client.asyncCall("unbindSocket", [binding, "listener", 1, true])).toBe(0);
});

test("socket connects use real symlinks, permissions and directory traversal", async () => {
  const f = await fixture();
  const scope = await attach(f);
  const binding = await bind(scope.client, scope.root);
  const link = f.fs.resolveAbsolute("/scope/link");
  const escape = f.fs.resolveAbsolute("/scope/escape");
  if (typeof link === "number" || typeof escape === "number") throw new Error("resolve");
  f.fs.symlink(link, "child/../listener");
  f.fs.symlink(escape, "../outside");
  expect(await scope.client.asyncCall("connectSocket", [scope.root, "/link"])).toEqual({
    ino: binding.ino,
  });
  expect(await scope.client.asyncCall("connectSocket", [scope.root, "/escape/file"])).toEqual({
    error: 76,
  });
  expect(await scope.client.asyncCall("connectSocket", [scope.root, "/file"])).toEqual({
    error: 14,
  });
  expect(await scope.client.asyncCall("connectSocket", [scope.root, "/missing"])).toEqual({
    error: 44,
  });
  expect(await scope.client.asyncCall("connectSocket", [scope.root, "/file/no"])).toEqual({
    error: 54,
  });
  f.fs.setMode(binding.node, 0o400);
  expect(await scope.client.asyncCall("connectSocket", [scope.root, "/listener"])).toEqual({
    error: 2,
  });
});

test("exact-edge unbind never removes a replacement or follows a renamed socket", async () => {
  const f = await fixture();
  const scope = await attach(f);
  const binding = await bind(scope.client, scope.root);
  await f.guest.asyncCall("move", ["/scope/listener", "/scope/renamed"]);
  const replacement = await bind(scope.client, scope.root, "/listener", 2);
  expect(await scope.client.asyncCall("unbindSocket", [binding, "listener", 1, true])).toBe(44);
  expect(f.fs.lookup("/scope/listener")?.ino).toBe(replacement.ino);
  expect(f.fs.lookup("/scope/renamed")?.ino).toBe(binding.ino);
});

test("ancestor rename cleanup uses the original parent edge and keeps the new pathname's replacement", async () => {
  const f = await fixture();
  const scope = await attach(f);
  const binding = await bind(scope.client, scope.root, "/child/listener");
  await f.guest.asyncCall("move", ["/scope/child", "/scope/moved"]);
  await f.guest.asyncCall("mkdirp", ["/scope/child"]);
  const replacement = await bind(scope.client, scope.root, "/child/listener", 2);
  expect(await scope.client.asyncCall("unbindSocket", [binding, "listener", 1, true])).toBe(0);
  expect(f.fs.lookup("/scope/moved/listener")).toBeUndefined();
  expect(f.fs.lookup("/scope/child/listener")?.ino).toBe(replacement.ino);
});

test("failed unlink retains lease and pins for retry; false leaves stale metadata", async () => {
  const f = await fixture();
  const scope = await attach(f);
  const binding = await bind(scope.client, scope.root);
  f.fs.setMode(binding.parent, 0o500);
  expect(await scope.client.asyncCall("unbindSocket", [binding, "listener", 1, true])).toBe(2);
  f.fs.setMode(binding.parent, 0o700);
  expect(await scope.client.asyncCall("unbindSocket", [binding, "listener", 1, true])).toBe(0);
  const stale = await bind(scope.client, scope.root, "/stale", 2);
  expect(await scope.client.asyncCall("unbindSocket", [stale, "stale", 2, false])).toBe(0);
  expect(f.fs.lookup("/scope/stale")?.kind).toBe("socket");
});

test("guest exit does not revoke socket scope cleanup", async () => {
  const f = await fixture();
  const scope = await attach(f);
  const binding = await bind(scope.client, scope.root);
  revokeFilesystem(f.guest.connection);
  f.service.sweep();
  expect(await scope.client.asyncCall("unbindSocket", [binding, "listener", 1, true])).toBe(0);
  expect(f.fs.lookup("/scope/listener")).toBeUndefined();
});

test("atomic pathname bind returns the actual symlink-sensitive parent and name", async () => {
  const f = await fixture();
  const scope = await attach(f);
  const resolved = f.fs.resolveAbsolute("/scope/alias");
  if (typeof resolved === "number") throw new Error("resolve");
  f.fs.symlink(resolved, "child");
  const value = await scope.client.asyncCall("bindSocketPath", [
    scope.root,
    "/alias/../listener",
    5,
  ]);
  expect(value.name).toBe("listener");
  expect(value.binding.parentIno).toBe(scope.rootIno);
  expect(f.fs.lookup("/scope/listener")?.ino).toBe(value.binding.ino);
  expect(await scope.client.asyncCall("bindSocketPath", [scope.root, "/listener", 6])).toEqual({
    error: 20,
  });
  expect(
    await scope.client.asyncCall("bindSocketPath", [scope.root, "/../outside/socket", 6]),
  ).toEqual({ error: 76 });
  expect(await scope.client.asyncCall("unbindSocket", [value.binding, value.name, 5, true])).toBe(
    0,
  );
});

test("socket bind and unlink publish actual inode and edge changes and wake watchers", async () => {
  const f = await fixture(true);
  const scope = await attach(f);
  const watch = await f.guest.watch(f.root, { recursive: true });
  try {
    const domain = f.backend.shared.publication!;
    const before = domain.cut();
    const value = await scope.client.asyncCall("bindSocketPath", [scope.root, "/listener", 1]);
    const inserted = await watch.read();
    expect(inserted.events).toContainEqual(
      expect.objectContaining({ type: "rename", name: "scope/listener" }),
    );
    const page = domain.changes(before, domain.limits.logBytes);
    if (page.kind !== "changes") throw new Error("publication gap");
    const effects = page.publications.flatMap((publication) => publication.changes);
    expect(effects).toContainEqual(expect.objectContaining({ kind: "inode", nodeKind: "socket" }));
    expect(effects).toContainEqual(
      expect.objectContaining({ kind: "entry", name: "listener", before: null }),
    );
    expect(await scope.client.asyncCall("unbindSocket", [value.binding, value.name, 1, true])).toBe(
      0,
    );
    const removed = await watch.read();
    expect(removed.events).toContainEqual(
      expect.objectContaining({ type: "rename", name: "scope/listener" }),
    );
    expect(f.service.resources().socketLeases).toBe(0);
  } finally {
    await watch.close();
  }
});

test("a directory moved out of an admitted scope cannot be used for a later bind", async () => {
  const f = await fixture();
  const scope = await attach(f);
  const path = await scope.client.asyncCall("resolve", [scope.root, "/child/listener"]);
  await f.guest.asyncCall("move", ["/scope/child", "/outside/child"]);
  const error = await scope.client
    .asyncCall("bindSocket", [path.parent, path.name, 1])
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ errno: 76 });
  expect(f.fs.lookup("/outside/child/listener")).toBeUndefined();
});

test("socket path admission keeps the 4096 UTF8 byte limit", async () => {
  const f = await fixture();
  const scope = await attach(f);
  expect(
    await scope.client.asyncCall("bindSocketPath", [scope.root, "/" + "é".repeat(2048), 1]),
  ).toEqual({ error: 37 });
  expect(await scope.client.asyncCall("bindSocketPath", [scope.root, "/bad\ud800", 1])).toEqual({
    error: 28,
  });
  const path = "/" + "a".repeat(4095);
  const value = await scope.client.asyncCall("bindSocketPath", [scope.root, path, 1]);
  expect(value.binding.ino).toBeGreaterThan(0);
  expect(await scope.client.asyncCall("connectSocket", [scope.root, path])).toEqual({
    ino: value.binding.ino,
  });
  expect(await scope.client.asyncCall("unbindSocket", [value.binding, value.name, 1, true])).toBe(
    0,
  );
});
