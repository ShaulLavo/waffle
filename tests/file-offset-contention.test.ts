import { afterEach, expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  connectFilesystemIdentity,
  createFilesystemConnection,
  createProcessFilesystemIdentity,
  reapFilesystem,
} from "../fs";
import { createFilesystemDescriptorCodec, isFilesystemDescriptorToken } from "../proc/filesystem-codec";
import type { OffsetEvent, OffsetRequest } from "./fixtures/file-offset-contention";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => {
    client.dispose();
    service.dispose();
  });
  await client.asyncCall("writeFile", ["/file"], new TextEncoder().encode("abcdef"));
  const root = await client.asyncCall("preopen", ["/"]);
  const { node: handle } = await client.asyncCall("resolve", [root, "file"]);
  client.retain(handle);
  const table = new DescriptorTable();
  const file = { kind: "file" as const, handle, offset: 0, append: false };
  const fd = table.open(file, 0x1fffffffn, 0n, () => client.release(handle));
  cleanups.push(() => table.dispose());
  function start(role: OffsetRequest["role"], gate: SharedArrayBuffer) {
    const identity = createProcessFilesystemIdentity(client.connection);
    const token = createFilesystemDescriptorCodec(client, identity).export(table.get(fd)!, 8);
    if (!isFilesystemDescriptorToken(token) || token.resource !== "file") throw new Error("expected file token");
    const child = connectFilesystemIdentity(identity);
    service.connect(child.server);
    const worker = new Worker(new URL("./fixtures/file-offset-contention.ts", import.meta.url).href);
    cleanups.push(() => {
      worker.terminate();
      reapFilesystem(identity);
    });
    const first = Promise.withResolvers<OffsetEvent>();
    const done = Promise.withResolvers<OffsetEvent>();
    worker.onmessage = ({ data }: MessageEvent<OffsetEvent>) => {
      first.resolve(data);
      if (data.kind === "done" || data.kind === "error") done.resolve(data);
    };
    worker.onerror = (error) => {
      first.reject(error);
      done.reject(error);
    };
    worker.postMessage({ connection: child.client, token, gate, role } satisfies OffsetRequest, [child.client.port]);
    return { worker, identity, token, first: first.promise, done: done.promise };
  }
  return { start, file, client };
}

function release(gate: SharedArrayBuffer) {
  const cells = new Int32Array(gate);
  Atomics.store(cells, 0, 1);
  Atomics.notify(cells, 0);
}

test("ordinary WASI writes park with bounded CAS work while backend I/O holds the cursor", async () => {
  const f = await fixture();
  const gate = new SharedArrayBuffer(4);
  const holder = f.start("holder", gate);
  expect(await holder.first).toEqual({ kind: "holding" });
  const contender = f.start("contender", gate);
  expect(await contender.first).toEqual({ kind: "parked", attempts: 3, waits: 3 });
  expect(f.file.offset).toBe(0);
  release(gate);
  expect(await holder.done).toMatchObject({ kind: "done", errno: 0, offset: 1 });
  const result = await contender.done;
  expect(result).toMatchObject({ kind: "done", errno: 0, offset: 2 });
  if (result.kind !== "done") throw new Error("expected completed write");
  expect(result.attempts).toBe(result.waits + 1);
  expect(new Int32Array(contender.identity.sections)[0]).toBe(0);
  const contents = new Uint8Array(6);
  expect(f.client.read(f.file.handle, [contents], 0)).toBe(6);
  expect(new TextDecoder().decode(contents)).toBe("HPcdef");
});
