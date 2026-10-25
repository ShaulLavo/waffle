import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { guardedStream } from "../browser/guarded-stream.js";
import type { Stream } from "../core/descriptors.js";
import { WasiExit } from "../core/wasi.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { nonblockGuest } from "./fixtures/wasi-nonblock.js";

test("actual WASI guarded pipe flag writes reject revocation without changing shared flags", () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read");
  const duplicate = pipe.duplicate(reader);
  let active = true;
  const guarded = guardedStream(reader, () => {
    if (!active) throw new WasiExit(1);
  });
  const guest = nonblockGuest({ 0: guarded });
  try {
    expect(guest.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    expect(duplicate.fdflags).toBe(4);
    active = false;
    expect(() => guest.call("fd_fdstat_set_flags", 0, 0)).toThrow(WasiExit);
    expect(reader.fdflags).toBe(4);
    expect(duplicate.fdflags).toBe(4);
    expect(() => guarded.tryRead!([new Uint8Array(1)])).toThrow(WasiExit);
    expect(() => guarded.close!()).not.toThrow();
  } finally {
    guest.wasi.descriptors.dispose();
    duplicate.close();
    pipe.dispose();
  }
});

test("actual WASI guarded own-field stream flags stay on the stream across dup", () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(1, "write");
  const stream: Stream = {
    kind: "pipe",
    fdflags: 0,
    read: (chunks) => reader.read(chunks),
    write: (chunks) => writer.write(chunks),
    tryRead: (chunks) => reader.tryRead(chunks),
    tryWrite: (chunks) => writer.tryWrite(chunks),
    readiness: () => reader.readiness(),
  };
  const guest = nonblockGuest({ 0: guardedStream(stream, () => {}) });
  try {
    const duplicate = guest.wasi.descriptors.dup(0);
    expect(guest.call("fd_fdstat_set_flags", duplicate, 4)).toBe(0);
    expect(stream.fdflags).toBe(4);
    expect(guest.flags(0)).toBe(4);
    expect(guest.io("fd_read", 0)).toBe(6);
    expect(guest.call("fd_fdstat_set_flags", 0, 0)).toBe(0);
    expect(stream.fdflags).toBe(0);
    expect(guest.flags(duplicate)).toBe(0);
    expect(writer.write([new Uint8Array([7])])).toBe(1);
    expect(guest.io("fd_read", duplicate)).toBe(0);
    expect(new Uint8Array(guest.memory.buffer)[4096]).toBe(7);
  } finally {
    guest.wasi.descriptors.dispose();
    pipe.dispose();
  }
});

test("guarded flags remain shared after actual Worker codec transfer and reject revoked writes", async () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(1, "write");
  const parent = nonblockGuest({ 0: guardedStream(reader, () => {}), 1: writer });
  let worker: Worker | undefined;
  try {
    const source = parent.wasi.descriptors.get(0)!;
    worker = new Worker(new URL("./fixtures/guarded-nonblock-worker.ts", import.meta.url), {
      workerData: {
        token: createWorkerPipeCodec().export(source, 3),
      },
    });
    expect(await once(worker, "message", { signal: AbortSignal.timeout(3000) })).toEqual(["ready"]);
    expect(parent.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    const result = once(worker, "message", { signal: AbortSignal.timeout(3000) });
    worker.postMessage("read");
    expect(await result).toEqual([
      { flags: 4, errno: 6, clear: 0, cleared: 0, denied: true, final: 0 },
    ]);
    expect(reader.fdflags).toBe(0);
    expect(parent.flags(0)).toBe(0);
    expect(parent.flags(1)).toBe(0);
  } finally {
    await worker?.terminate();
    parent.wasi.descriptors.dispose();
    pipe.dispose();
  }
});

test("unrelated guarded writes retain Proxy receiver semantics and cleanup keeps the stream receiver", () => {
  let active = true;
  const stream = {
    kind: "terminal" as const,
    marker: 1,
    read() {
      expect(this).toBe(stream);
      return 0;
    },
    write() {
      expect(this).toBe(stream);
      return 0;
    },
    readiness() {
      expect(this).toBe(stream);
      return { readable: true, writable: true, hangup: false };
    },
    close() {
      expect(this).toBe(stream);
    },
  };
  const guarded = guardedStream(stream, () => {
    if (!active) throw new WasiExit(1);
  });
  expect(guarded.read([])).toBe(0);
  active = false;
  expect(Reflect.set(guarded, "marker", 2)).toBe(true);
  expect(stream.marker).toBe(1);
  expect(Object.getOwnPropertyDescriptor(guarded, "marker")?.value).toBe(2);
  expect(Reflect.get(guarded, "marker")).toBe(1);
  expect(() => guarded.read([])).toThrow(WasiExit);
  expect(() => guarded.close!()).not.toThrow();
});
