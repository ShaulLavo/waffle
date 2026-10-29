import { hostFilesystemClient } from "./fixtures/filesystem-host.js";
import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection, reapFilesystem } from "../fs/protocol.js";

function interruptRegistration(
  backend: MemoryBackend,
  page: FilesystemClient,
  phase: "contention" | "capture",
  reap: () => void,
): void {
  if (phase === "contention") {
    // An occupied peer lock enters the real contention callback and session sweep.
    Atomics.store(backend.shared.cells, 1, page.connection.owner);
    backend.shared.onContention = () => {
      Atomics.store(backend.shared.cells, 1, 0);
      reap();
    };
    return;
  }
  const ensureIdentity = backend.ensureIdentity.bind(backend);
  backend.ensureIdentity = (node) => {
    backend.ensureIdentity = ensureIdentity;
    reap();
    return ensureIdentity(node);
  };
}

for (const phase of ["contention", "capture"] as const) {
  test(`watch registration cannot outlive an owner reaped during ${phase}`, async () => {
    const pair = createFilesystemConnection();
    const backend = new MemoryBackend();
    const service = new FilesystemService(backend);
    service.connect(pair.server);
    const page = hostFilesystemClient(service, pair);
    const guest = new FilesystemClient(page.fork());
    const ensureIdentity = backend.ensureIdentity.bind(backend);
    let interrupted = false;
    const reap = () => {
      interrupted = true;
      reapFilesystem(guest.connection);
      service.sweep();
    };
    try {
      const pageRoot = await page.asyncCall("preopen", ["/"]);
      const root = await guest.asyncCall("preopen", ["/"]);
      interruptRegistration(backend, page, phase, reap);
      await expect(guest.watch(root)).rejects.toMatchObject({ errno: 11 });
      expect(interrupted).toBe(true);
      service.sweep();
      expect(backend.shared.watch.active).toBe(false);
      backend.ensureIdentity = ensureIdentity;
      backend.shared.onContention = () => service.sweep();
      const live = await page.watch(pageRoot);
      expect(backend.shared.watch.cells[0]).toBe(1);
      await live.close();
      expect(backend.shared.watch.active).toBe(false);
    } finally {
      Atomics.store(backend.shared.cells, 1, 0);
      backend.ensureIdentity = ensureIdentity;
      backend.shared.onContention = () => service.sweep();
      guest.dispose();
      page.dispose();
      await service.shutdown();
    }
  }, 5000);
}
