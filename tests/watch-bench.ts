import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { SharedFilesystemState } from "../fs/shared.js";
import { strict as assert } from "node:assert";

async function drain(watches: Awaited<ReturnType<FilesystemClient["watch"]>>[]): Promise<number> {
  let delivered = 0;
  for (const watch of watches) {
    const batch = await watch.read();
    assert.equal(batch.kind, "events");
    delivered += batch.events.length;
  }
  return delivered;
}
async function installBurst(
  client: FilesystemClient,
  watches: Awaited<ReturnType<FilesystemClient["watch"]>>[],
): Promise<number> {
  let delivered = 0;
  for (let index = 0; index < 64; index++) {
    await client.asyncCall("writeFile", ["/install-" + index], new Uint8Array(1024));
    if (index % 8 === 7) delivered += await drain(watches);
  }
  return delivered;
}

const backend = new MemoryBackend();
const pair = createFilesystemConnection();
const service = new FilesystemService(backend);
service.connect(pair.server);
const client = new FilesystemClient(pair.client);
const guest = new FilesystemClient(client.fork());
const baseline = process.argv.includes("--baseline");
const watches: Awaited<ReturnType<FilesystemClient["watch"]>>[] = [];
try {
  const root = await client.asyncCall("preopen", ["/"]);
  const guestRoot = await guest.asyncCall("preopen", ["/"]);
  await client.asyncCall("writeFile", ["/one"], new Uint8Array(65536));
  const path = await guest.asyncCall("resolve", [guestRoot, "one"]);
  guest.retain(path.node);
  const results: Record<string, unknown> = {
    runtime: Bun.version,
    baseline,
    standaloneRootBytes: new SharedFilesystemState().buffer.byteLength,
    connectedRootBytes: backend.shared.buffer.byteLength,
    metadataBytes: backend.shared.resources().metadataBytes,
  };
  function measure(bytes: number): number[] {
    const payload = new Uint8Array(bytes);
    for (let i = 0; i < 3000; i++) assert.equal(guest.write(path.node, [payload], 0), bytes);
    return Array.from({ length: 7 }, () => {
      const begin = performance.now();
      for (let i = 0; i < 10000; i++) guest.write(path.node, [payload], 0);
      return ((performance.now() - begin) * 1000) / 10000;
    }).sort((a, b) => a - b);
  }
  results.unwatchedMicrosecondsPerWrite = [1, 4096, 65536].map((bytes) => ({
    bytes,
    samples: measure(bytes),
  }));
  if (!baseline) {
    const call = guest.asyncCall.bind(guest);
    let writerRequests = 0;
    guest.asyncCall = (...args) => {
      writerRequests++;
      return call(...args);
    };
    watches.push(await client.watch(root, { recursive: true }));
    results.watchedMicrosecondsPerWrite = [1, 4096, 65536].map((bytes) => ({
      bytes,
      samples: measure(bytes),
    }));
    results.directWriterRPCs = writerRequests;
    await watches.pop()!.close();
    const identity = backend.ensureIdentity.bind(backend);
    let metadataVisits = 0;
    backend.ensureIdentity = (node) => {
      metadataVisits++;
      return identity(node);
    };
    Bun.gc(true);
    const heap = process.memoryUsage().heapUsed;
    const begin = performance.now();
    for (let index = 0; index < 64; index++)
      watches.push(await client.watch(root, { recursive: true }));
    Bun.gc(true);
    results.registration = {
      watches: 64,
      milliseconds: performance.now() - begin,
      metadataVisits,
      approximateHeapDelta: process.memoryUsage().heapUsed - heap,
    };
    let readerRequests = 0;
    const read = client.asyncCall.bind(client);
    client.asyncCall = (...args) => {
      readerRequests++;
      return read(...args);
    };
    const pending = watches[0]!.next();
    await Bun.sleep(25);
    const armed = readerRequests;
    const visits = metadataVisits;
    const cpu = process.cpuUsage();
    await Bun.sleep(250);
    results.idle = {
      milliseconds: 250,
      readerRequestsAfterArm: readerRequests - armed,
      metadataVisits: metadataVisits - visits,
      processCpuMicroseconds: process.cpuUsage(cpu),
    };
    guest.write(path.node, [new Uint8Array([9])], 0);
    assert.equal((await pending).kind, "events");
    const burst = performance.now();
    const delivered = await installBurst(client, watches);
    results.burst = {
      creates: 64,
      overlappingWatches: 64,
      eventsDelivered: delivered,
      milliseconds: performance.now() - burst,
    };
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const watch of watches) await watch.close();
  client.dispose();
  guest.dispose();
  await service.shutdown();
}
