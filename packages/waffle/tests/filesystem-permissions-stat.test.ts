import { hostFilesystemClient } from "../testing/fixtures/filesystem-host.js";
import { expect, test } from "bun:test";
import { FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs";
import { CLIENT_MODE_NO_CLIENT_CACHE, CLIENT_MODE_NO_DIRECT_IO } from "../fs/shared";
import { permissionsFor } from "../core/filesystem";

test("permissions given the caller's stat answer from it without another request", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = hostFilesystemClient(service, pair);
  try {
    await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
    const root = await client.asyncCall("preopen", ["/"]);
    const handle = (await client.asyncCall("resolve", [root, "file"])).node as number;
    await client.asyncCall("setMode", [handle, 0o400]);
    const stat = await client.asyncCall("stat", [handle]);
    // The multi-tab host's mode: every stat is a filesystem request.
    client.shared.setClientMode(CLIENT_MODE_NO_DIRECT_IO | CLIENT_MODE_NO_CLIENT_CACHE);
    expect(client.shared.isDirectDisabled()).toBe(true);
    // A blocking request here would wait on this thread's own service, so fail it instead.
    Reflect.set(client, "submit", () => {
      throw new Error("unexpected filesystem request");
    });
    expect(client.permissions(handle, stat)).toEqual(permissionsFor("file", 0o400));
  } finally {
    client.dispose();
    await service.drainForOwner();
    service.dispose();
  }
});
