import { DescriptorTable } from "../../core/descriptors";
import { FilesystemClient, FilesystemService, PersistentBackend } from "../../fs";
import { connectFilesystemIdentity, createFilesystemIdentity, createProcessFilesystemIdentity, PAGE } from "../../fs/protocol";
import { createFilesystemDescriptorCodec, type FilesystemDescriptorToken } from "../../proc/filesystem-codec";
import type { StorageBackend } from "../../fs/storage";

export const coldSize = 32 * 1024 * 1024;
export const coldByte = (offset: number) => (offset * 17 + Math.floor(offset / PAGE) * 29 + 3) & 255;
export async function coldDescriptorFixture() {
  const counters = { wholeBytes: 0, rangeBytes: 0, ranges: [] as { offset: number; length: number }[], retained: 0 };
  const storage: StorageBackend = {
    async reserveIdentity() { return { workspace: "a110ca7e-0000-4000-8000-000000000001", era: 1n }; },
    async load() {
      return { version: 1, generation: 1, root: 1, nodes: [
        { ino: 1, kind: "dir", size: 0, mode: 0o700, mtime: 1, children: [["file", 2]] },
        { ino: 2, kind: "file", size: coldSize, mode: 0o600, mtime: 1, data: "cold" },
      ] };
    },
    async read() {
      counters.wholeBytes += coldSize;
      return Uint8Array.from({ length: coldSize }, (_, index) => coldByte(index));
    },
    async readRange(_key, range) {
      range.signal?.throwIfAborted();
      counters.rangeBytes += range.length;
      counters.ranges.push({ offset: range.offset, length: range.length });
      return Uint8Array.from({ length: range.length }, (_, index) => coldByte(range.offset + index));
    },
    retainPayload() { counters.retained++; return { release() { counters.retained--; } }; },
    async persist() {}, async flush() {}, async close() {},
  };
  const backend = await PersistentBackend.open(storage, { intervalMs: 0, dirtyLimits: false });
  const service = new FilesystemService(backend);
  const pair = connectFilesystemIdentity(createFilesystemIdentity(undefined, 16 * 1024 * 1024, { workspace: true }));
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const table = new DescriptorTable();
  const workers: Worker[] = [];
  const childPorts: MessagePort[] = [];
  const close = async () => {
    for (const worker of workers) worker.terminate();
    table.dispose();
    client.dispose();
    await service.drainForOwner();
    service.dispose();
    await backend.close();
    for (const port of childPorts) port.close();
    pair.client.port.close(); pair.server.port.close();
  };
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const handle: number = (await client.asyncCall("resolve", [root, "file"])).node;
    client.retain(handle);
    const fd = table.open({ kind: "file", handle, offset: 0, append: false }, 0x1fffffffn, 0n, () => client.release(handle));
    const run = (reads: readonly { offset: number; length: number }[]) => {
      const identity = createProcessFilesystemIdentity(client.connection);
      const token = createFilesystemDescriptorCodec(client, identity).export(table.get(fd)!, 2) as FilesystemDescriptorToken;
      const child = connectFilesystemIdentity(identity);
      service.connect(child.server);
      childPorts.push(child.server.port);
      const worker = new Worker(new URL("./cold-descriptor-guest.ts", import.meta.url).href);
      workers.push(worker);
      return new Promise<{ results: { error: number; count: number; bytes: number[] }[]; failure?: string }>((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error("cold descriptor worker timeout")); }, 5000);
        worker.onerror = (error) => { clearTimeout(timer); reject(error); };
        worker.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
        worker.postMessage({ connection: child.client, token, reads }, [child.client.port]);
      });
    };
    return { backend, service, client, handle, storage, counters, close, run };
  } catch (error) { await close(); throw error; }
}
