import { afterEach, expect, test } from "bun:test";
import { withFileOffset } from "../core/open-file";
import { DescriptorTable } from "../core/descriptors";
import {
  connectFilesystemIdentity,
  createProcessFilesystemIdentity,
  reapFilesystem,
  revokeFilesystem,
  revokeFilesystemService,
  waitForFilesystemQuiescence,
} from "../fs";
import {
  createFilesystemDescriptorCodec,
  isFilesystemDescriptorToken,
} from "../proc/filesystem-codec";
import { filesystemFileFixture } from "./fixtures/filesystem-file";
import { atomicHost } from "./fixtures/wasi-atomic-host";
import type { OffsetEvent, OffsetRequest } from "./fixtures/file-offset-contention";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const { service, client, handle } = await filesystemFileFixture(cleanups);
  const table = new DescriptorTable();
  const file = { kind: "file" as const, handle, offset: 0, append: false };
  const fd = table.open(file, 0x1fffffffn, 0n, () => client.release(handle));
  cleanups.push(() => table.dispose());
  function start(
    role: OffsetRequest["role"],
    gate: SharedArrayBuffer,
    operation: OffsetRequest["operation"] = "write",
  ) {
    const identity = createProcessFilesystemIdentity(client.connection);
    const token = createFilesystemDescriptorCodec(client, identity).export(table.get(fd)!, 8);
    if (!isFilesystemDescriptorToken(token) || token.resource !== "file")
      throw new Error("expected file token");
    const child = connectFilesystemIdentity(identity);
    service.connect(child.server);
    const worker = new Worker(
      new URL("./fixtures/file-offset-contention.ts", import.meta.url).href,
    );
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
      const result: OffsetEvent = { kind: "error", message: error.message, attempts: 0, waits: 0 };
      first.resolve(result);
      done.resolve(result);
    };
    worker.postMessage(
      { connection: child.client, token, gate, role, operation } satisfies OffsetRequest,
      [child.client.port],
    );
    return { worker, identity, token, first: first.promise, done: done.promise };
  }
  return { start, file, client, table, fd };
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
  expect(await holder.done).toMatchObject({ kind: "done", errno: 0 });
  const result = await contender.done;
  expect(result).toMatchObject({ kind: "done", errno: 0, offset: 2 });
  if (result.kind !== "done") throw new Error("expected completed write");
  expect(result.attempts).toBe(result.waits + 1);
  expect(new Int32Array(contender.identity.sections)[0]).toBe(0);
  const contents = new Uint8Array(6);
  expect(f.client.read(f.file.handle, [contents], 0)).toBe(6);
  expect(new TextDecoder().decode(contents)).toBe("HPcdef");
});

test("an uncontended shared WASI write acquires once without parking", async () => {
  const f = await fixture();
  const contender = f.start("contender", new SharedArrayBuffer(4));
  expect(await contender.done).toEqual({
    kind: "done",
    errno: 0,
    offset: 1,
    byte: 80,
    attempts: 1,
    waits: 0,
  });
});

for (const revocation of ["waiter", "service"] as const) {
  test(`a parked ${revocation}-revoked waiter leaves admission while the owner still holds the lock`, async () => {
    const f = await fixture();
    const gate = new SharedArrayBuffer(4);
    const holder = f.start("holder", gate);
    expect(await holder.first).toEqual({ kind: "holding" });
    const contender = f.start("contender", gate);
    expect(await contender.first).toMatchObject({ kind: "parked" });
    if (revocation === "waiter") await waitForFilesystemQuiescence(contender.identity);
    else revokeFilesystemService(f.client.connection);
    expect(await contender.done).toMatchObject({ kind: "done", errno: 11, offset: 0 });
    expect(new Int32Array(contender.identity.sections)[0]).toBe(0);
    expect(new Int32Array(contender.token.offset!)[0]).toBe(holder.identity.owner);
    expect(new Int32Array(holder.identity.sections)[0]).toBe(1);
  });
}

test("a parked waiter steals an abandoned lock only after its owner is stopped and reaped", async () => {
  const f = await fixture();
  const gate = new SharedArrayBuffer(4);
  const holder = f.start("holder", gate);
  expect(await holder.first).toEqual({ kind: "holding" });
  const contender = f.start("contender", gate);
  expect(await contender.first).toMatchObject({ kind: "parked" });
  revokeFilesystem(holder.identity);
  expect(withFileOffset(f.file, () => 123, true)).toBe(-6);
  expect(new Int32Array(contender.token.offset!)[0]).toBe(holder.identity.owner);
  holder.worker.terminate();
  reapFilesystem(holder.identity);
  expect(await contender.done).toMatchObject({ kind: "done", errno: 0, offset: 1 });
  expect(new Int32Array(contender.identity.sections)[0]).toBe(0);
  expect(new Int32Array(contender.token.offset!)[0]).toBe(0);
});

for (const operation of ["read", "append", "seek"] as const) {
  test(`a parked WASI ${operation} selects its cursor after the holder advances it`, async () => {
    const f = await fixture();
    const gate = new SharedArrayBuffer(4);
    const holder = f.start("holder", gate);
    expect(await holder.first).toEqual({ kind: "holding" });
    if (operation === "append") f.file.append = true;
    const contender = f.start("contender", gate, operation);
    expect(await contender.first).toEqual({ kind: "parked", attempts: 3, waits: 3 });
    expect(f.file.offset).toBe(0);
    release(gate);
    expect(await holder.done).toMatchObject({ kind: "done", errno: 0 });
    const expectedOffset = { read: 2, append: 7, seek: 3 }[operation];
    const result = await contender.done;
    expect(result).toMatchObject({ kind: "done", errno: 0, offset: expectedOffset });
    if (operation === "read") expect(result).toMatchObject({ byte: 98 });
    expect(f.file.offset).toBe(expectedOffset);
    const contents = new Uint8Array(7);
    const length = f.client.read(f.file.handle, [contents], 0);
    expect(new TextDecoder().decode(contents.subarray(0, length))).toBe(
      operation === "append" ? "HbcdefP" : "Hbcdef",
    );
  });
}

test("WASI positioned I/O stays independent of a held shared cursor", async () => {
  const f = await fixture();
  const gate = new SharedArrayBuffer(4);
  const holder = f.start("holder", gate);
  expect(await holder.first).toEqual({ kind: "holding" });
  const host = atomicHost(f.client, {});
  cleanups.push(() => host.wasi.descriptors.dispose());
  host.wasi.descriptors.inherit(8, f.table.get(f.fd)!);
  host.iovecs([new Uint8Array([81])]);
  expect(host.calls.fd_pwrite!(8, 0, 1, 4n, 1024)).toBe(0);
  expect(host.calls.fd_pread!(8, 0, 1, 4n, 1024)).toBe(0);
  expect(new Uint8Array(host.memory.buffer)[2048]).toBe(81);
  expect(f.file.offset).toBe(0);
  expect(new Int32Array(holder.token.offset!)[0]).toBe(holder.identity.owner);
  release(gate);
  expect(await holder.done).toMatchObject({ kind: "done", errno: 0 });
  const contents = new Uint8Array(6);
  expect(f.client.read(f.file.handle, [contents], 0)).toBe(6);
  expect(new TextDecoder().decode(contents)).toBe("HbcdQf");
});
