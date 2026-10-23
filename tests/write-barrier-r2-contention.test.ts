import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection, reapFilesystem } from "../fs/protocol";

async function heldGlobal(
  run: (client: FilesystemClient, handle: number, held: Int32Array) => Promise<void>,
) {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const control = new Int32Array(new SharedArrayBuffer(8));
  const guest = client.fork();
  const worker = new Worker(new URL("./fixtures/write-barrier-r2-worker.ts", import.meta.url).href);
  const ready = Promise.withResolvers<void>();
  worker.onmessage = () => ready.resolve();
  worker.onerror = (error) => ready.reject(new Error(error.message));
  try {
    await client.asyncCall("writeFile", ["/shared"], new Uint8Array([1]));
    const root: number = await client.asyncCall("preopen", ["/"]);
    const path: { node: number } = await client.asyncCall("resolve", [root, "shared"]);
    client.retain(path.node);
    backend.shared.dirtyAdmission.configure(
      { maxBytes: 1024 * 1024, maxMetadataBytes: 1024 * 1024 },
      { maxBytes: 1024 * 1024, maxMetadataBytes: 1024 * 1024, maxOperations: 64 },
      0,
    );
    worker.postMessage({ connection: guest, mode: "global-lock", control: control.buffer }, [
      guest.port,
    ]);
    await ready.promise;
    await run(client, path.node, control);
    expect(backend.shared.snapshot(path.node)?.data).toEqual(new Uint8Array([1]));
    expect(backend.shared.writeAdmission.active).toBe(0);
  } finally {
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    await worker.terminate();
    reapFilesystem(guest);
    client.dispose();
    service.dispose();
    pair.server.port.close();
  }
}

test("try admission returns while a real worker still holds the dirty global lock", async () => {
  await heldGlobal(async (client, handle, held) => {
    const result = client.tryWrite(handle, [new Uint8Array([2])], 0);
    expect(Atomics.load(held, 1)).toBe(0);
    expect(result).toBe(-6);
    Atomics.store(held, 0, 1);
    Atomics.notify(held, 0);
  });
});

test("async page preparation yields under the dirty global lock without copying input", async () => {
  await heldGlobal(async (client, _handle, held) => {
    let copies = 0;
    const preparing = client.prepareAsync(
      "writeFile",
      ["/later"],
      () => {
        copies++;
        return new Uint8Array([2]);
      },
      1,
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(Atomics.load(held, 1)).toBe(0);
      expect(copies).toBe(0);
    } finally {
      Atomics.store(held, 0, 1);
      Atomics.notify(held, 0);
      const completion = await preparing;
      completion.release();
    }
    expect(copies).toBe(1);
  });
});
