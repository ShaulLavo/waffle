import { afterEach, expect, test } from "bun:test";
import { createServiceReaders, attachServiceAccess } from "../browser/display/service-readers.js";
import { FencedCommandReader } from "../browser/gpu/command-reader.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { words } from "./fixtures/gpu/core-fixture.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

test("close is irreversible and exact joins are cached", async () => {
  const first = createServiceReaders(),
    second = createServiceReaders();
  const access = attachServiceAccess(first.bootstrap);
  let ran = 0;
  access.run(() => {
    ran++;
    return undefined;
  });
  const closed = first.close();
  expect(first.close()).toBe(closed);
  expect(closed.join()).toBe(closed.join());
  expect(
    access.run(() => {
      ran++;
      return undefined;
    }),
  ).toBe("closed");
  const proof = await closed.join();
  expect(closed.accepts(proof)).toBe(true);
  expect(second.close().accepts(proof)).toBe(false);
  expect(closed.accepts({})).toBe(false);
  expect(ran).toBe(1);
});

test("nested actual command reads finish before join and saved reads are denied", async () => {
  const fence = createServiceReaders();
  const access = attachServiceAccess(fence.bootstrap);
  const backing = new SharedArrayBuffer(128);
  const ring = new RecordRing(backing, 8);
  const reader = new FencedCommandReader(ring, access);
  const writer = ring.tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("writer missing");
  writer.writer.tryWrite(words(1, []));
  writer.writer.release();
  let joined = false;
  let pending!: Promise<unknown>;
  access.run(() => {
    pending = fence
      .close()
      .join()
      .then(() => {
        joined = true;
      });
    expect(joined).toBe(false);
    expect(reader.readInto(new Uint8Array(64))).toEqual({ kind: "reader-closed" });
    return undefined;
  });
  await pending;
  expect(joined).toBe(true);
  const frozen = new Int32Array(backing).slice();
  expect(reader.readInto(new Uint8Array(64))).toEqual({ kind: "reader-closed" });
  expect(Array.from(new Int32Array(backing))).toEqual(Array.from(frozen));
});

async function arrived(cells: Int32Array): Promise<void> {
  while (Atomics.load(cells, 0) === 0) {
    const wait = Atomics.waitAsync(cells, 0, 0);
    if (wait.async) await wait.value;
  }
}
for (const abandoned of [false, true])
  test(`actual CPU-worker read joins its admitted physical store (${abandoned})`, async () => {
    const fence = createServiceReaders();
    const commands = new SharedArrayBuffer(128);
    const ring = new RecordRing(commands, 8);
    const writer = ring.tryAcquireWriter();
    if (writer.kind !== "acquired") throw new Error("writer missing");
    writer.writer.tryWrite(words(1, []));
    writer.writer.release();
    const rendezvous = new SharedArrayBuffer(8),
      cells = new Int32Array(rendezvous);
    let worker: Worker | undefined;
    cleanup.push(async () => {
      if (worker) await worker.terminate();
    });
    worker = new Worker(new URL("./fixtures/gpu/service-reader-worker.ts", import.meta.url));
    const result = new Promise<unknown>((resolve, reject) => {
      worker!.onmessage = ({ data }) => resolve(data);
      worker!.onerror = reject;
    });
    worker.postMessage({ fence: fence.bootstrap, commands, rendezvous });
    await arrived(cells);
    let joined = false;
    const joining = fence
      .close()
      .join()
      .then(() => {
        joined = true;
      });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(Atomics.load(new Int32Array(commands), 2)).toBe(0);
    if (abandoned) {
      await worker.terminate();
      worker = undefined;
      await Promise.resolve();
      expect(joined).toBe(false);
      expect(Atomics.load(new Int32Array(fence.bootstrap), 0)).toBe(-2);
      return;
    }
    Atomics.store(cells, 1, 1);
    Atomics.notify(cells, 1);
    await joining;
    expect(await result).toEqual({
      first: { kind: "record", bytes: 8 },
      second: { kind: "reader-closed" },
    });
    expect(Atomics.load(new Int32Array(commands), 2)).toBe(8);
  });

test("count exhaustion never wraps, and spurious notifications cannot join an active frame", async () => {
  const fence = createServiceReaders(),
    access = attachServiceAccess(fence.bootstrap);
  const cells = new Int32Array(fence.bootstrap);
  Atomics.store(cells, 0, 0x7fffffff);
  expect(() => access.run(() => undefined)).toThrow("exhausted");
  fence.close();
  expect(Atomics.load(cells, 0)).toBe(-0x80000000);
  let joined = false;
  void fence
    .close()
    .join()
    .then(() => {
      joined = true;
    });
  Atomics.notify(cells, 0);
  await Promise.resolve();
  expect(joined).toBe(false);
});

for (const kind of ["padding-short", "rollover", "corrupt", "detached-short"])
  test(`complete physical read owns ${kind} stores and exceptions`, async () => {
    const fence = createServiceReaders(),
      access = attachServiceAccess(fence.bootstrap);
    const backing = new SharedArrayBuffer(128),
      cells = new Int32Array(backing),
      data = new DataView(backing, 64);
    const ring = new RecordRing(backing, 8);
    const publication = new BigInt64Array(backing, 0, 1);
    if (kind === "rollover") {
      Atomics.store(publication, 0, 24n);
      Atomics.store(cells, 2, -16);
      data.setUint32(48, 0, true);
      data.setUint32(52, 16, true);
      data.setUint32(0, 1, true);
      data.setUint32(4, 24, true);
    } else if (kind === "padding-short") {
      Atomics.store(publication, 0, 80n);
      Atomics.store(cells, 2, 56);
      data.setUint32(56, 0, true);
      data.setUint32(60, 8, true);
      data.setUint32(0, 1, true);
      data.setUint32(4, 16, true);
    } else {
      Atomics.store(publication, 0, 8n);
      data.setUint32(0, 1, true);
      data.setUint32(4, kind === "corrupt" ? 7 : 8, true);
    }
    const read = ring.readInto;
    ring.readInto = function (destination) {
      fence.close();
      return read.call(this, destination);
    };
    const reader = new FencedCommandReader(ring, access);
    const destination = new Uint8Array(kind === "padding-short" ? 8 : 64);
    if (kind === "detached-short")
      structuredClone(destination.buffer, { transfer: [destination.buffer] });
    if (kind === "corrupt") expect(() => reader.readInto(destination)).toThrow();
    else if (kind === "detached-short")
      expect(reader.readInto(destination)).toEqual({ kind: "short", required: 8 });
    else
      expect(reader.readInto(destination)).toEqual(
        kind === "rollover" ? { kind: "record", bytes: 24 } : { kind: "short", required: 16 },
      );
    await fence.close().join();
    const frozen = Array.from(new Uint8Array(backing));
    expect(reader.readInto(new Uint8Array(64))).toEqual({ kind: "reader-closed" });
    expect(Array.from(new Uint8Array(backing))).toEqual(frozen);
    if (kind === "rollover") expect(Atomics.load(cells, 2)).toBe(24);
    if (kind === "padding-short") expect(Atomics.load(cells, 2)).toBe(64);
  });

test("production scheduler drain reenters after yielding and cannot replay copied work after join", async () => {
  const { GpuConnection, GpuScheduler } = await import("../browser/gpu/scheduler.js");
  const { ServiceCredit } = await import("../browser/gpu/protocol.js");
  const { command, handle, ROOT } = await import("./fixtures/gpu/core-fixture.js");
  const fence = createServiceReaders(),
    access = attachServiceAccess(fence.bootstrap);
  const backing = new SharedArrayBuffer(4160),
    commands = new RecordRing(backing, 8);
  const replies = new RecordRing(new SharedArrayBuffer(4160), 16);
  let nativeCalls = 0;
  const connection = new GpuConnection(
    commands,
    replies,
    {
      root: {
        requestAdapter() {
          nativeCalls++;
          return Promise.resolve(null);
        },
      },
    },
    new ServiceCredit(),
    { access },
  );
  cleanup.push(() => connection.completions.abandon());
  const writer = commands.tryAcquireWriter();
  if (writer.kind !== "acquired") throw new Error("writer missing");
  writer.writer.tryWrite(
    command("instance.request_adapter", {
      receiver: ROOT,
      result: handle(2),
      token: 1,
      options: null,
    }),
  );
  writer.writer.release();
  const scheduler = new GpuScheduler();
  scheduler.add(connection);
  let baseline: number[] = [],
    yields = 0;
  await scheduler.drain(
    async () => {
      yields++;
      commands.terminate(5);
      await fence.close().join();
      baseline = Array.from(new Uint8Array(backing));
    },
    { bytes: 1, milliseconds: 1, now: () => 0 },
  );
  expect(yields).toBe(1);
  expect(nativeCalls).toBe(0);
  expect(Array.from(new Uint8Array(backing))).toEqual(baseline);
});
