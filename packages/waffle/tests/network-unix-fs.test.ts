import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRuntime, type Runtime, type RuntimeNetwork } from "../index.js";
import { createRing } from "../browser/net/ring.js";
import { ERROR, OK } from "../browser/net/protocol.js";
import { FilesystemClient } from "../fs/client.js";
import { revokeFilesystem, type FilesystemIdentity } from "../fs/protocol.js";
import { disposeLive, Guest, live, readEnd } from "./network-unix-support.js";

const noFetch = async () => {
  throw Error("External fetch forbidden");
};
let runtime: Runtime;
let network: RuntimeNetwork;
let admin: FilesystemClient;
let adminRoot: number;
beforeEach(async () => {
  runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  });
  network = await runtime.network();
  await runtime.filesystem.mkdirp("/run/sub");
  admin = new FilesystemClient(runtime.filesystem.connect(runtime.filesystem.createIdentity()));
  adminRoot = await admin.asyncCall("preopen", ["/"]);
});
afterEach(async () => {
  disposeLive();
  admin.dispose();
  await runtime.dispose();
});

/** A guest identity that holds `directory` in its own table, like a preopened process. */
async function scoped(directory = "/") {
  const identity = runtime.filesystem.createIdentity();
  const client = new FilesystemClient(runtime.filesystem.connect(identity));
  const root = await client.asyncCall("preopen", ["/"]);
  if (directory !== "/") {
    const resolved = await client.asyncCall("resolve", [root, directory.slice(1)]);
    client.retain(resolved.node);
  }
  const lease = await runtime.filesystem.directoryHandle(directory);
  const ring = createRing();
  const helper = network.createHelper({
    ring,
    fetch: noFetch,
    pathScope: { filesystem: identity, directory: lease.handle },
  });
  live.push({ dispose: () => client.dispose() });
  live.push({ dispose: () => lease.release() });
  live.push({ dispose: () => helper.dispose() });
  return Object.assign(new Guest(helper, ring), { identity, client });
}

async function kind(path: string) {
  return (await runtime.filesystem.lookup(path))?.kind;
}

async function code(guest: Guest) {
  return (await guest.error()).code;
}

async function symlink(path: string, target: string) {
  const resolved = await admin.asyncCall("resolve", [adminRoot, path.slice(1), false]);
  expect(await admin.asyncCall("symlink", [resolved, target])).toBe(0);
}

async function chmod(path: string, mode: number) {
  const resolved = await admin.asyncCall("resolve", [adminRoot, path.slice(1), false]);
  expect(await admin.asyncCall("setMode", [resolved.node, mode])).toBe(0);
}

test("bind creates a real socket node; close unlinks it by default and keeps it when asked", async () => {
  const server = await scoped();
  const client = await scoped();
  const listener = await server.call("listenPath", "/run/a.sock");
  expect(listener).toBeGreaterThan(0);
  expect(await kind("/run/a.sock")).toBe("socket");
  const conn = await client.call("connectPath", "/run/a.sock");
  const accepted = await server.accept(listener);
  expect(await client.call("write", conn, new Uint8Array([1, 2]))).toBe(2);
  expect(await server.readAll(accepted, 2)).toEqual(new Uint8Array([1, 2]));
  expect(await server.call("close", listener)).toBe(OK);
  expect(await kind("/run/a.sock")).toBeUndefined();
  expect(await server.call("write", accepted, new Uint8Array([3]))).toBe(1);
  expect(await client.readAll(conn, 1)).toEqual(new Uint8Array([3]));

  const kept = await server.call("listenPath", "/run/b.sock", { unlinkOnClose: false });
  expect(await server.call("close", kept)).toBe(OK);
  expect(await kind("/run/b.sock")).toBe("socket");
  expect(await client.call("connectPath", "/run/b.sock")).toBe(ERROR);
  expect(await code(client)).toBe("ECONNREFUSED");
  expect(await server.call("listenPath", "/run/b.sock")).toBe(ERROR);
  expect(await code(server)).toBe("EADDRINUSE");
});

test("explicit unlink stops new connects, keeps live streams, and allows a rebind", async () => {
  const server = await scoped();
  const client = await scoped();
  const listener = await server.call("listenPath", "/run/u.sock");
  const conn = await client.call("connectPath", "/run/u.sock");
  const accepted = await server.accept(listener);
  expect(await runtime.filesystem.remove("/run/u.sock")).toBe(true);
  expect(await client.call("connectPath", "/run/u.sock")).toBe(ERROR);
  expect(await code(client)).toBe("ENOENT");
  expect(await client.call("write", conn, new Uint8Array([9]))).toBe(1);
  expect(await server.readAll(accepted, 1)).toEqual(new Uint8Array([9]));
  const second = await server.call("listenPath", "/run/u.sock");
  expect(second).toBeGreaterThan(0);
  // The old listener's close compares its exact lease and never removes the replacement.
  expect(await server.call("close", listener)).toBe(OK);
  expect(await kind("/run/u.sock")).toBe("socket");
  expect(await client.call("connectPath", "/run/u.sock")).toBeGreaterThan(0);
});

test("a renamed socket keeps working at its new name and close leaves it stale", async () => {
  const server = await scoped();
  const client = await scoped();
  const listener = await server.call("listenPath", "/run/old.sock");
  await runtime.filesystem.move("/run/old.sock", "/run/new.sock");
  expect(await client.call("connectPath", "/run/old.sock")).toBe(ERROR);
  expect(await code(client)).toBe("ENOENT");
  expect(await client.call("connectPath", "/run/new.sock")).toBeGreaterThan(0);
  expect(await server.call("close", listener)).toBe(OK);
  expect(await kind("/run/new.sock")).toBe("socket");
  expect(await client.call("connectPath", "/run/new.sock")).toBe(ERROR);
  expect(await code(client)).toBe("ECONNREFUSED");
});

test("after an ancestor rename, close removes the original edge and keeps the old pathname's replacement", async () => {
  const server = await scoped();
  const other = await scoped();
  const listener = await server.call("listenPath", "/run/sub/s.sock");
  await runtime.filesystem.move("/run/sub", "/run/moved");
  await runtime.filesystem.mkdirp("/run/sub");
  const replacement = await other.call("listenPath", "/run/sub/s.sock");
  expect(replacement).toBeGreaterThan(0);
  expect(await server.call("close", listener)).toBe(OK);
  expect(await kind("/run/moved/s.sock")).toBeUndefined();
  expect(await kind("/run/sub/s.sock")).toBe("socket");
  expect(await server.call("connectPath", "/run/sub/s.sock")).toBeGreaterThan(0);
});

test("bind refuses every occupied name and does not follow a final symlink", async () => {
  const server = await scoped();
  await runtime.filesystem.writeFile("/run/file", "x");
  await symlink("/run/link", "nowhere");
  const stale = await server.call("listenPath", "/run/stale", { unlinkOnClose: false });
  await server.call("close", stale);
  for (const path of ["/run/file", "/run/sub", "/run/link", "/run/stale"]) {
    expect(await server.call("listenPath", path)).toBe(ERROR);
    expect(await code(server)).toBe("EADDRINUSE");
  }
  expect(await kind("/nowhere")).toBeUndefined();
});

test("connect walks the real tree: symlinks, loops, kinds and permissions", async () => {
  const server = await scoped();
  const client = await scoped();
  await server.call("listenPath", "/run/real.sock");
  await runtime.filesystem.writeFile("/run/file", "x");
  await symlink("/run/alias.sock", "sub/../real.sock");
  await symlink("/run/loop", "loop");
  expect(await client.call("connectPath", "/run/alias.sock")).toBeGreaterThan(0);
  expect(await client.call("connectPath", "/run//sub/../real.sock")).toBeGreaterThan(0);
  const cases: [string, string][] = [
    ["/run/missing", "ENOENT"],
    ["/run/file", "ECONNREFUSED"],
    ["/run/sub", "ECONNREFUSED"],
    ["/run/loop", "ELOOP"],
    ["/run/file/x", "ENOTDIR"],
    ["/missing/x.sock", "ENOENT"],
  ];
  for (const [path, expected] of cases) {
    expect(await client.call("connectPath", path)).toBe(ERROR);
    expect(await code(client)).toBe(expected);
  }
  await chmod("/run/real.sock", 0o400);
  expect(await client.call("connectPath", "/run/real.sock")).toBe(ERROR);
  expect(await code(client)).toBe("EACCES");
  await chmod("/run/sub", 0o500);
  expect(await server.call("listenPath", "/run/sub/denied.sock")).toBe(ERROR);
  expect(await code(server)).toBe("EACCES");
  expect(await server.call("listenPath", "/run/file/x.sock")).toBe(ERROR);
  expect(await code(server)).toBe("ENOTDIR");
});

test("scope roots: same root shares names, another root is refused, escapes are not capable", async () => {
  const server = await scoped();
  const peer = await scoped();
  const nested = await scoped("/run");
  await server.call("listenPath", "/run/shared.sock");
  expect(await peer.call("connectPath", "/run/shared.sock")).toBeGreaterThan(0);
  // Inside /run the same node is "/shared.sock", but that scope's root differs.
  expect(await nested.call("connectPath", "/shared.sock")).toBe(ERROR);
  expect(await code(nested)).toBe("ECONNREFUSED");
  expect(await nested.call("listenPath", "/../escape.sock")).toBe(ERROR);
  expect(await code(nested)).toBe("ENOTCAPABLE");
  expect(await kind("/escape.sock")).toBeUndefined();
  expect(await nested.call("listenPath", "/inner.sock")).toBeGreaterThan(0);
  expect(await kind("/run/inner.sock")).toBe("socket");
});

test("attach rejects a directory the guest does not hold, and a revoked guest", async () => {
  const lease = await runtime.filesystem.directoryHandle("/run");
  live.push({ dispose: () => lease.release() });
  const identity = runtime.filesystem.createIdentity();
  const client = new FilesystemClient(runtime.filesystem.connect(identity));
  live.push({ dispose: () => client.dispose() });
  await client.asyncCall("preopen", ["/"]);
  const ring = createRing();
  const helper = network.createHelper({
    ring,
    fetch: noFetch,
    pathScope: { filesystem: identity, directory: lease.handle },
  });
  live.push({ dispose: () => helper.dispose() });
  const guest = new Guest(helper, ring);
  expect(await guest.call("listenPath", "/x.sock")).toBe(ERROR);
  expect(await code(guest)).toBe("ENOTCAPABLE");

  const revoked = await scoped();
  revokeFilesystem(revoked.identity as FilesystemIdentity);
  expect(await revoked.call("listenPath", "/run/r.sock")).toBe(ERROR);
  expect(await code(revoked)).toBe("ECANCELED");
  expect(await kind("/run/r.sock")).toBeUndefined();
});

test("guest exit after attach does not stop helper cleanup from unlinking", async () => {
  const server = await scoped();
  const client = await scoped();
  await server.call("listenPath", "/run/exit.sock");
  const conn = await client.call("connectPath", "/run/exit.sock");
  revokeFilesystem(server.identity);
  server.helper.dispose();
  expect(await readEnd(client, conn)).toBe(0);
  for (let i = 0; i < 50 && (await kind("/run/exit.sock")); i++) await Bun.sleep(10);
  expect(await kind("/run/exit.sock")).toBeUndefined();
});

test("a failed acknowledged close keeps its lease and the owner retries it", async () => {
  const server = await scoped();
  const listener = await server.call("listenPath", "/run/sub/held.sock");
  await chmod("/run/sub", 0o500);
  expect(await server.call("close", listener)).toBe(ERROR);
  expect(await server.error()).toMatchObject({ code: "EACCES", syscall: "close" });
  expect(await kind("/run/sub/held.sock")).toBe("socket");
  await chmod("/run/sub", 0o700);
  server.helper.dispose();
  // Runtime disposal joins the retained unbind; with the parent writable again it settles.
  disposeLive();
  admin.dispose();
  await runtime.dispose();
  runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  });
  admin = new FilesystemClient(runtime.filesystem.connect(runtime.filesystem.createIdentity()));
});
