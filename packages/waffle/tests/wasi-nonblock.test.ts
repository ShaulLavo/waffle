import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { PipeController } from "../proc/pipes.js";
import { nonblockGuest } from "./fixtures/wasi-nonblock.js";

const encoder = new TextEncoder();
function pipe() {
  const controller = new PipeController({ capacity: 8, relay: "manual" });
  return {
    controller,
    reader: controller.retain(1, "read"),
    writer: controller.retain(2, "write"),
  };
}
function using(run: (p: ReturnType<typeof pipe>, g: ReturnType<typeof nonblockGuest>) => void) {
  const p = pipe();
  const g = nonblockGuest({ 0: p.reader, 1: p.writer });
  try {
    run(p, g);
  } finally {
    g.wasi.descriptors.dispose();
    p.controller.dispose();
  }
}

test("public stdio flags round-trip and dup/inherit share flags without widening rights", () => {
  using((_p, g) => {
    const source = g.wasi.descriptors.get(0)!;
    const originalRights = source.rightsBase;
    expect(originalRights & 8n).toBe(8n);
    expect(g.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    expect(g.flags(0)).toBe(4);
    expect(g.flags(1)).toBe(0);
    const dup = g.wasi.descriptors.dup(0);
    const child = nonblockGuest();
    try {
      child.wasi.descriptors.inherit(7, source);
      expect(child.flags(7)).toBe(4);
      expect(g.flags(dup)).toBe(4);
      expect(child.call("fd_fdstat_set_flags", 7, 0)).toBe(0);
      expect(g.flags(0)).toBe(0);
      expect(g.flags(dup)).toBe(0);
      expect(source.rightsBase).toBe(originalRights);
    } finally {
      child.wasi.descriptors.dispose();
    }
  });
});

interface IoResult {
  set: number;
  clear: number | null;
  flags: number;
  errno: number;
  count: number;
  released: number;
}
function ioReply(worker: Worker, ready: () => void): Promise<IoResult> {
  return new Promise<IoResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WASI worker timed out")), 3000);
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.on("message", (message: IoResult | { ready: true }) => {
      if ("ready" in message) return ready();
      clearTimeout(timeout);
      resolve(message);
    });
  });
}
async function blockedIo(operation: "fd_read" | "fd_write", clear: boolean): Promise<IoResult> {
  const p = pipe();
  const released = new SharedArrayBuffer(4);
  if (operation === "fd_write") expect(p.writer.tryWrite([encoder.encode("12345678")])).toBe(8);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const worker = new Worker(new URL("./fixtures/wasi-nonblock-worker.ts", import.meta.url), {
    workerData: {
      endpoint: (operation === "fd_read" ? p.reader : p.writer).handle(),
      operation,
      clear,
      released,
    },
  });
  const release = () => {
    Atomics.store(new Int32Array(released), 0, 1);
    if (operation === "fd_read") p.writer.tryWrite([encoder.encode("x")]);
    else p.reader.tryRead([new Uint8Array(8)]);
  };
  try {
    return await ioReply(worker, () => {
      timer = setTimeout(release, 60);
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
    p.reader.close();
    p.writer.close();
    p.controller.dispose();
  }
}
for (const operation of ["fd_read", "fd_write"] as const) {
  test(`public stdio NONBLOCK ${operation} returns AGAIN before peer release`, async () => {
    expect(await blockedIo(operation, false)).toEqual({
      set: 0,
      clear: null,
      flags: 4,
      errno: 6,
      count: 0xabcdef,
      released: 0,
    });
  });
  test(`clearing NONBLOCK restores blocking ${operation} until peer release`, async () => {
    expect(await blockedIo(operation, true)).toEqual({
      set: 0,
      clear: 0,
      flags: 0,
      errno: 0,
      count: 1,
      released: 1,
    });
  });
}

test("NONBLOCK preserves short I/O, zero length, EOF and broken pipe", () => {
  using((p, g) => {
    expect(g.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    expect(g.call("fd_fdstat_set_flags", 1, 4)).toBe(0);
    new Uint8Array(g.memory.buffer).set(encoder.encode("abcdefghijkl"), 4096);
    expect(g.io("fd_write", 1, 12)).toBe(0);
    expect(g.view.getUint32(264, true)).toBe(8);
    expect(g.io("fd_read", 0, 12)).toBe(0);
    expect(g.view.getUint32(264, true)).toBe(8);
    expect(g.io("fd_read", 0, 0)).toBe(0);
    expect(g.io("fd_write", 1, 0)).toBe(0);
    p.writer.close();
    expect(g.io("fd_read", 0)).toBe(0);
    expect(g.view.getUint32(264, true)).toBe(0);
  });
  using((p, g) => {
    expect(g.call("fd_fdstat_set_flags", 1, 4)).toBe(0);
    p.reader.close();
    expect(g.io("fd_write", 1)).toBe(64);
    expect(g.io("fd_write", 1, 0)).toBe(0);
  });
});

test("stream flag validation preserves flags and rights precedence", () => {
  using((_p, g) => {
    expect(g.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    for (const flag of [1, 2, 8, 16]) expect(g.call("fd_fdstat_set_flags", 0, flag)).toBe(58);
    expect(g.flags(0)).toBe(4);
    expect(g.call("fd_fdstat_set_flags", 0, 32)).toBe(28);
    const rights = g.wasi.descriptors.get(0)!.rightsBase;
    expect(g.call("fd_fdstat_set_rights", 0, rights & ~8n, 0n)).toBe(0);
    expect(g.call("fd_fdstat_set_flags", 0, 0)).toBe(76);
    expect(g.flags(0)).toBe(4);
    expect(g.call("fd_fdstat_set_rights", 0, 0n, 0n)).toBe(0);
    expect(g.io("fd_read", 0)).toBe(76);
    expect(g.call("fd_fdstat_set_flags", 999, 32)).toBe(8);
  });
});

test("terminal without shared flags or immediate input rejects NONBLOCK", () => {
  const g = nonblockGuest(
    {},
    {
      stdin: () => {
        throw new Error("must not enter blocking stdin");
      },
    },
  );
  try {
    expect(g.call("fd_fdstat_set_flags", 0, 4)).toBe(58);
    expect(g.call("fd_fdstat_set_flags", 1, 4)).toBe(58);
    expect(g.flags(0)).toBe(0);
    expect(g.call("fd_fdstat_set_flags", 0, 0)).toBe(0);
  } finally {
    g.wasi.descriptors.dispose();
  }
});
