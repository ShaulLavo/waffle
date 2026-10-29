import { expect, test } from "bun:test";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { FilesystemClient } from "../fs/client.js";
import { CAPABILITY_HEADER, CAPABILITY_LENGTH, CAPABILITY_WORDS } from "../fs/protocol.js";

function references(filesystem: SharedFilesystem, handle: number) {
  const entries = new Int32Array(filesystem.client.connection.capabilities, 0, CAPABILITY_LENGTH);
  for (let at = CAPABILITY_HEADER; at < entries.length; at += CAPABILITY_WORDS) {
    if (entries[at] === handle && entries[at + 1]! >= 0) return entries[at + 1];
  }
  return undefined;
}

test("directory leases release one page pin each and runtime disposal releases remaining pins", async () => {
  const page = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  });
  let handle = -1;
  try {
    for (let count = 0; count < 32; count++) {
      const lease = await page.directoryHandle("/");
      handle = lease.handle;
      expect(references(page, handle)).toBe(1);
      lease.release();
      lease.release();
      expect(references(page, handle)).toBe(0);
    }
    await page.directoryHandle("/");
    expect(references(page, handle)).toBe(1);
  } finally {
    await page.dispose();
  }
  expect(new Int32Array(page.client.connection.ownerStates)[page.client.connection.owner]).toBe(2);
  expect(() => page.client.stat(handle)).toThrow();
}, 10000);

test("real owner control attaches an independently retained scope and rejects foreign identities", async () => {
  const page = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  });
  const foreign = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  });
  let guest: FilesystemClient | undefined,
    scope: Awaited<ReturnType<SharedFilesystem["attachSocketScope"]>> | undefined;
  try {
    await page.mkdirp("/scope");
    const directory = await page.directoryHandle("/scope");
    guest = new FilesystemClient(page.connect(page.createIdentity()));
    const root = await guest.asyncCall("preopen", ["/"]);
    const resolved = await guest.asyncCall("resolve", [root, "scope"]);
    guest.retain(resolved.node);
    scope = await page.attachSocketScope(guest.connection, directory.handle);
    directory.release();
    const value = await scope.client.asyncCall("bindSocketPath", [scope.root, "/listener", 1]);
    expect(value.name).toBe("listener");
    guest.dispose();
    guest = undefined;
    expect(await scope.client.asyncCall("unbindSocket", [value.binding, value.name, 1, true])).toBe(
      0,
    );
    expect(await page.lookup("/scope/listener")).toBeUndefined();
    const otherLease = await foreign.directoryHandle("/");
    try {
      const error = await page
        .attachSocketScope(foreign.client.connection, otherLease.handle)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ errno: 76 });
    } finally {
      otherLease.release();
    }
  } finally {
    guest?.dispose();
    if (scope) {
      await page.quiesce(scope.client.connection);
      scope.client.dispose();
    }
    await page.dispose();
    await foreign.dispose();
  }
}, 10000);

test("public scope attachment preserves ECANCELED for a revoked guest holding a root", async () => {
  const page = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  });
  const guest = new FilesystemClient(page.connect(page.createIdentity()));
  try {
    const directory = await page.directoryHandle("/");
    const root = await guest.asyncCall("preopen", ["/"]);
    guest.retain(root);
    page.revoke(guest.connection);
    const error = await page
      .attachSocketScope(guest.connection, directory.handle)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ errno: 11 });
    directory.release();
  } finally {
    guest.dispose();
    await page.dispose();
  }
});
