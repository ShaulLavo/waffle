import { hostFilesystemClient } from "./fixtures/filesystem-host.js";
import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection, reapFilesystem, revokeFilesystem } from "../fs/protocol.js";
import type { watchGuest } from "./fixtures/watch-guest.js";

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

type GuestReply =
  | { opened: { errno: number; id: number }; pending: boolean }
  | {
      drained: ReturnType<ReturnType<typeof watchGuest>["drain"]>;
      pending: boolean;
    };

test("a force-terminated guest's import watches return the root to zero subscriptions", async () => {
  const pair = createFilesystemConnection();
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const page = hostFilesystemClient(service, pair);
  const worker = new Worker(new URL("./fixtures/guest-watch-worker.ts", import.meta.url).href);
  const replies: GuestReply[] = [];
  const waiters: (() => void)[] = [];
  worker.onmessage = ({ data }: MessageEvent<GuestReply>) => {
    replies.push(data);
    waiters.shift()?.();
  };
  const reply = async (index: number) => {
    while (replies.length <= index) await new Promise<void>((resolve) => waiters.push(resolve));
    return replies[index]!;
  };
  const control = new Int32Array(new SharedArrayBuffer(8));
  const connection = page.fork();
  try {
    await page.asyncCall("writeFile", ["/a", false], new Uint8Array([1]));
    worker.postMessage({ connection, control: control.buffer }, [connection.port]);
    expect(await reply(0)).toEqual({ opened: { errno: 0, id: 1 }, pending: false });
    expect(Atomics.load(backend.shared.watch.cells, 0)).toBe(1);
    await page.asyncCall("writeFile", ["/a", false], new Uint8Array([2]));
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    expect(await reply(1)).toEqual({
      drained: { errno: 0, ended: false, records: [{ type: 1, name: "a" }] },
      pending: false,
    });
    revokeFilesystem(connection);
    worker.terminate();
    reapFilesystem(connection);
    service.sweep();
    expect(Atomics.load(backend.shared.watch.cells, 0)).toBe(0);
    expect(backend.shared.watch.active).toBe(false);
  } finally {
    worker.terminate();
    page.dispose();
    await service.shutdown();
  }
}, 10000);
