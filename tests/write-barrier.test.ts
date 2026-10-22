import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection } from "../fs/protocol";

const bytes = (value: string) => new TextEncoder().encode(value);
class HeldBackend extends MemoryBackend {
  entered = Promise.withResolvers<void>();
  released = Promise.withResolvers<void>();
  override async flush(): Promise<void> {
    this.entered.resolve();
    await this.released.promise;
  }
}

test("owner cut excludes a retained independent direct writer throughout held flush", async () => {
  const backend = new HeldBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const page = new FilesystemClient(pair.client);
  const guestPair = createFilesystemConnection(pair.client);
  service.connect(guestPair.server);
  const guest = new FilesystemClient(guestPair.client);
  let flushing: Promise<unknown> | undefined;
  try {
    await page.asyncCall("writeFile", ["/shared", false, false], bytes("before"));
    const root: number = await guest.asyncCall("preopen", ["/"]);
    const path: { node: number } = await guest.asyncCall("resolve", [root, "shared"]);
    guest.retain(path.node);
    // Initial owner adapter is the existing page drain/flush contract, not a missing API.
    flushing = page.asyncCall("flush");
    await backend.entered.promise;
    expect(guest.tryWrite(path.node, [bytes("during")], 0)).toBe(-6);
    expect(backend.shared.snapshot(path.node)).toEqual(bytes("before"));
  } finally {
    backend.released.resolve();
    await flushing;
    guest.dispose();
    page.dispose();
    service.dispose();
    pair.server.port.close();
    guestPair.server.port.close();
  }
});
