import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { guardedStream } from "../browser/guarded-stream.js";
import { PipeController } from "../proc/pipes.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { fixtureSpawnRequest } from "./fixtures/spawn-request.js";
import { nonblockGuest } from "./fixtures/wasi-nonblock.js";

function inheritedResult(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("inherited WASI worker timed out")), 3000);
    worker.once("message", (message: unknown) => {
      clearTimeout(timeout);
      resolve(message);
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("worker pipe codec preserves shared NONBLOCK through real WASI after transfer", async () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(1, "write");
  const parent = nonblockGuest({ 0: reader, 1: writer });
  let worker: Worker | undefined;
  try {
    expect(parent.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    const source = parent.wasi.descriptors.get(0)!;
    const token = createWorkerPipeCodec().export(source, 3);
    worker = new Worker(new URL("./fixtures/wasi-nonblock-inherited-worker.ts", import.meta.url), {
      workerData: {
        token,
        pid: 3,
        rightsBase: source.rightsBase,
        rightsInheriting: source.rightsInheriting,
      },
    });
    expect(await inheritedResult(worker)).toEqual({
      flags: 4,
      errno: 6,
      clear: 0,
      rights: source.rightsBase,
    });
    expect(parent.flags(0)).toBe(0);
    expect(parent.flags(1)).toBe(0);
  } finally {
    await worker?.terminate();
    parent.wasi.descriptors.dispose();
    pipe.dispose();
  }
});

test("supervisor forProcess inheritance preserves NONBLOCK and independent rights", () => {
  const pipe = new PipeController({ relay: "manual" });
  const parent = nonblockGuest({ 0: pipe.retain(1, "read"), 1: pipe.retain(1, "write") });
  const child = nonblockGuest();
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("not launched");
    },
  });
  try {
    const pid = supervisor.createRoot({ descriptors: parent.wasi.descriptors });
    expect(parent.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    const childPid = supervisor.reserveSpawn(
      pid,
      fixtureSpawnRequest({ fds: [{ parent: 0, child: 7 }] }),
    );
    child.wasi.descriptors.inherit(7, supervisor.get(childPid)!.descriptors.get(7)!);
    expect(child.flags(7)).toBe(4);
    expect(child.io("fd_read", 7)).toBe(6);
    const rights = parent.wasi.descriptors.get(0)!.rightsBase;
    expect(child.call("fd_fdstat_set_rights", 7, rights & ~8n, 0n)).toBe(0);
    expect(child.call("fd_fdstat_set_flags", 7, 0)).toBe(76);
    expect(parent.flags(0)).toBe(4);
    expect(parent.wasi.descriptors.get(0)!.rightsBase).toBe(rights);
    expect(parent.call("fd_fdstat_set_flags", 0, 0)).toBe(0);
    expect(child.flags(7)).toBe(0);
  } finally {
    child.wasi.descriptors.dispose();
    supervisor.dispose();
    parent.wasi.descriptors.dispose();
    pipe.dispose();
  }
});

test("browser guarded pipe endpoint preserves shared flag writes", () => {
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(1, "write");
  const guest = nonblockGuest({ 0: guardedStream(reader, () => {}), 1: writer });
  try {
    expect(guest.call("fd_fdstat_set_flags", 0, 4)).toBe(0);
    expect(reader.fdflags).toBe(4);
    expect(guest.flags(0)).toBe(4);
    expect(guest.io("fd_read", 0)).toBe(6);
    expect(guest.call("fd_fdstat_set_flags", 0, 0)).toBe(0);
    expect(reader.fdflags).toBe(0);
  } finally {
    guest.wasi.descriptors.dispose();
    pipe.dispose();
  }
});
