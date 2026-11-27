import { describe, expect, test } from "bun:test";
import { Wasi } from "../core/wasi";
import { RIGHT_FD_SEEK, RIGHT_FD_TELL } from "../core/rights";
import { MemFS } from "../fs/memory";
import { ProcessABI } from "../proc/abi";
import { ProcessErrno } from "../proc/errors";
import { PtyEndpoint, PTY_GEOMETRY_BYTES, attachPtyEndpoint } from "../proc/pty";
import type { PipeEndpointHandle } from "../proc/pipes";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { createWorkerProcessTransport, type WorkerProcessMessage } from "../proc/worker-client";
import { WorkerPipeBroker, WorkerPipeHost } from "../proc/worker-pipes";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals";
import { guestModule } from "./fixtures/publication-wasm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wasiMod = guestModule("wasi_snapshot_preview1", [
  { name: "fd_fdstat_get", parameters: ["i32", "i32"] },
  { name: "fd_fdstat_set_flags", parameters: ["i32", "i32"] },
  { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
  { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
  { name: "fd_close", parameters: ["i32"] },
]);

function createPtyFixture() {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const fs = new MemFS();
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const wasi = new Wasi({
    args: ["pty-test"],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const wasiImports = wasi.imports(wasiMod);
  wasi.start(new WebAssembly.Instance(wasiMod, wasiImports));
  const wasiCalls = wasiImports.wasi_snapshot_preview1 as Record<
    string,
    (...args: number[]) => number
  >;
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("unexpected launch");
    },
  });
  const pid = supervisor.createRoot({ descriptors: wasi.descriptors });
  const abi = new ProcessABI({
    processIdentity: supervisor.get(pid)!.processIdentity,
    memory,
    descriptors: wasi.descriptors,
    fs,
    pid,
    service: supervisor,
    signals: supervisor.get(pid)!,
    wake,
  });
  const bytes = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  return { memory, fs, wake, wasi, wasiCalls, supervisor, pid, abi, bytes, view };
}

function pollOnce(
  abi: ProcessABI,
  view: DataView,
  kind: number,
  fd: number,
): { count: number; flags: number } {
  view.setUint32(8192, kind, true);
  view.setUint32(8196, fd, true);
  view.setBigUint64(8200, 42n, true);
  const count = abi.imports.poll!(8192, 1, 0, 8400);
  const flags = count > 0 ? view.getUint32(8408, true) : 0;
  return { count, flags };
}

async function sampleConsistentResizes(
  master: { size(): { cols: number; rows: number; seq: number } },
  iterations: number,
  isSettled: () => boolean,
): Promise<void> {
  let lastSeq = 0;
  let samples = 0;
  const deadline = Date.now() + 10_000;
  while (lastSeq < iterations && !isSettled() && Date.now() < deadline) {
    const snap = master.size();
    expect(snap.seq).toBeGreaterThanOrEqual(lastSeq);
    expect(snap.cols).toBe(80 + (snap.seq % 500));
    expect(snap.rows).toBe(24 + (snap.seq % 200));
    lastSeq = snap.seq;
    if (++samples % 64 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("guest PTY host primitive (runtime_proc.pty_*)", () => {
  test("pty_open creates full-duplex pair with slave TTY identity and master non-TTY", () => {
    const f = createPtyFixture();
    const v = f.view();

    expect(f.abi.imports.pty_open!(80, 24, 1024)).toBe(0);
    const masterFd = v.getUint32(1024, true);
    const slaveFd = v.getUint32(1028, true);
    expect(masterFd).toBeGreaterThanOrEqual(4);
    expect(slaveFd).toBeGreaterThan(masterFd);

    // fd_kind: master is pipe (1), slave is terminal (2)
    expect(f.abi.imports.fd_kind!(masterFd)).toBe(1);
    expect(f.abi.imports.fd_kind!(slaveFd)).toBe(2);

    // WASI fd_fdstat_get: slave is FT_CHAR (2) with no seek/tell rights -> isatty() === true
    expect(f.wasiCalls.fd_fdstat_get!(slaveFd, 2048)).toBe(0);
    expect(v.getUint8(2048)).toBe(2); // FT_CHAR
    const slaveRights = v.getBigUint64(2056, true);
    expect(slaveRights & (RIGHT_FD_SEEK | RIGHT_FD_TELL)).toBe(0n);

    // Master is non-character (0) -> isatty() === false
    expect(f.wasiCalls.fd_fdstat_get!(masterFd, 2048)).toBe(0);
    expect(v.getUint8(2048)).toBe(0);

    // Full-duplex I/O: master -> slave
    const input = encoder.encode("ls -la\n");
    f.bytes().set(input, 3000);
    expect(f.abi.imports.write!(masterFd, 3000, input.length)).toBe(input.length);
    expect(pollOnce(f.abi, v, 0, slaveFd)).toEqual({ count: 1, flags: 0 });
    expect(f.abi.imports.read!(slaveFd, 3100, 64)).toBe(input.length);
    expect(decoder.decode(f.bytes().subarray(3100, 3100 + input.length))).toBe("ls -la\n");

    // Full-duplex I/O: slave -> master via WASI fd_write / fd_read
    const output = encoder.encode("file.txt\r\n");
    f.bytes().set(output, 3200);
    v.setUint32(4000, 3200, true);
    v.setUint32(4004, output.length, true);
    expect(f.wasiCalls.fd_write!(slaveFd, 4000, 1, 4020)).toBe(0);
    expect(v.getUint32(4020, true)).toBe(output.length);

    expect(pollOnce(f.abi, v, 0, masterFd)).toEqual({ count: 1, flags: 0 });
    v.setUint32(4000, 3300, true);
    v.setUint32(4004, 64, true);
    expect(f.wasiCalls.fd_read!(masterFd, 4000, 1, 4020)).toBe(0);
    const nread = v.getUint32(4020, true);
    expect(decoder.decode(f.bytes().subarray(3300, 3300 + nread))).toBe("file.txt\r\n");

    // Nonblocking empty read returns EAGAIN via FDFLAG_NONBLOCK
    expect(f.wasiCalls.fd_fdstat_set_flags!(masterFd, 4)).toBe(0);
    expect(f.wasiCalls.fd_read!(masterFd, 4000, 1, 4020)).toBe(ProcessErrno.AGAIN);

    expect(f.wasiCalls.fd_close!(slaveFd)).toBe(0);
    expect(f.wasiCalls.fd_close!(masterFd)).toBe(0);
  });

  test("pty_resize and pty_size update shared geometry, increment seq, notify wake, and validate errors", () => {
    const f = createPtyFixture();
    const v = f.view();

    // Validation on pty_open
    expect(f.abi.imports.pty_open!(0, 24, 1024)).toBe(-ProcessErrno.INVAL);
    expect(f.abi.imports.pty_open!(80, 0, 1024)).toBe(-ProcessErrno.INVAL);
    expect(f.abi.imports.pty_open!(-1, 24, 1024)).toBe(-ProcessErrno.INVAL);
    expect(f.abi.imports.pty_open!(65536, 24, 1024)).toBe(-ProcessErrno.INVAL);
    expect(f.abi.imports.pty_open!(80, 24, f.memory.buffer.byteLength - 4)).toBe(-21); // EFAULT

    // Open PTY
    expect(f.abi.imports.pty_open!(100, 30, 1024)).toBe(0);
    const masterFd = v.getUint32(1024, true);
    const slaveFd = v.getUint32(1028, true);

    // Initial size matches on both master and slave
    expect(f.abi.imports.pty_size!(masterFd, 2048)).toBe(0);
    expect([v.getUint32(2048, true), v.getUint32(2052, true), v.getUint32(2056, true)]).toEqual([
      100, 30, 0,
    ]);
    expect(f.abi.imports.pty_size!(slaveFd, 2048)).toBe(0);
    expect([v.getUint32(2048, true), v.getUint32(2052, true), v.getUint32(2056, true)]).toEqual([
      100, 30, 0,
    ]);

    // Resize from master increments seq and notifies wake word; visible from slave
    const wakeBefore = Atomics.load(f.wake, 0);
    expect(f.abi.imports.pty_resize!(masterFd, 132, 43)).toBe(0);
    expect(Atomics.load(f.wake, 0)).toBeGreaterThan(wakeBefore);
    expect(f.abi.imports.pty_size!(slaveFd, 2048)).toBe(0);
    expect([v.getUint32(2048, true), v.getUint32(2052, true), v.getUint32(2056, true)]).toEqual([
      132, 43, 1,
    ]);

    // Resize from slave also works
    expect(f.abi.imports.pty_resize!(slaveFd, 65535, 1)).toBe(0);
    expect(f.abi.imports.pty_size!(masterFd, 2048)).toBe(0);
    expect([v.getUint32(2048, true), v.getUint32(2052, true), v.getUint32(2056, true)]).toEqual([
      65535, 1, 2,
    ]);

    // Invalid dimensions on pty_resize
    expect(f.abi.imports.pty_resize!(masterFd, 0, 24)).toBe(-ProcessErrno.INVAL);
    expect(f.abi.imports.pty_resize!(masterFd, 80, 65536)).toBe(-ProcessErrno.INVAL);

    // ENOTTY on pipe, root directory, and default non-PTY stdout terminal
    expect(f.abi.imports.pipe!(1040)).toBe(0);
    const pipeReadFd = v.getUint32(1040, true);
    expect(f.abi.imports.pty_size!(pipeReadFd, 2048)).toBe(-ProcessErrno.NOTTY);
    expect(f.abi.imports.pty_resize!(pipeReadFd, 80, 24)).toBe(-ProcessErrno.NOTTY);
    expect(f.abi.imports.pty_size!(3, 2048)).toBe(-ProcessErrno.NOTTY); // root preopen dir
    expect(f.abi.imports.pty_size!(1, 2048)).toBe(-ProcessErrno.NOTTY); // default stdout terminal

    // EBADF on closed / unknown fd and EFAULT on OOB pointer
    expect(f.abi.imports.pty_size!(999, 2048)).toBe(-ProcessErrno.BADF);
    expect(f.abi.imports.pty_resize!(999, 80, 24)).toBe(-ProcessErrno.BADF);
    expect(f.abi.imports.pty_size!(masterFd, f.memory.buffer.byteLength - 8)).toBe(-21);

    expect(f.wasiCalls.fd_close!(masterFd)).toBe(0);
    expect(f.wasiCalls.fd_close!(slaveFd)).toBe(0);
  });

  test("WorkerPipeHost + RuntimeTerminalCodec preserve grandchild EOF barrier, exec successor, and revocation", () => {
    const broker = new WorkerPipeBroker({ relay: "manual" });
    const transport = createWorkerProcessTransport({ pid: 10 });
    const messages: WorkerProcessMessage[] = [];
    const host = new WorkerPipeHost({
      transport,
      postMessage(message) {
        messages.push(message);
        if (message.operation === "pipe") broker.attach(message.handle as PipeEndpointHandle);
      },
    });
    host.registry.registerProcess(11); // child
    host.registry.registerProcess(12); // grandchild

    try {
      const [master, slave] = host.createPty(80, 24);
      expect(messages.filter((m) => m.operation === "pipe")).toHaveLength(2);
      expect(master.kind).toBe("pipe");
      expect(slave.kind).toBe("terminal");

      // RuntimeTerminalCodec delegates PtyEndpoint slave to WorkerPipeCodec while still rejecting arbitrary callback terminals
      const codec = createRuntimeTerminalCodec({ fallback: host.codec() });
      const execCodec = createRuntimeTerminalCodec({ fallback: host.codec(undefined, true) });
      const fakeCallbackTerminal = {
        kind: "terminal" as const,
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: false, writable: false, hangup: false }),
      };
      expect(() =>
        codec.export(
          {
            description: {} as any,
            resource: fakeCallbackTerminal,
            rightsBase: 0n,
            rightsInheriting: 0n,
          },
          11,
        ),
      ).toThrow();

      // Transfer slave to child (pid 11) and grandchild (pid 12)
      const childToken = codec.export(
        { description: {} as any, resource: slave, rightsBase: 0n, rightsInheriting: 0n },
        11,
      );
      const childDesc = codec.import(childToken, 11);
      const childSlave = childDesc.resource as PtyEndpoint;
      expect(childSlave).toBeInstanceOf(PtyEndpoint);
      expect(childSlave.kind).toBe("terminal");

      const grandToken = codec.export(
        { description: childDesc, resource: childSlave, rightsBase: 0n, rightsInheriting: 0n },
        12,
      );
      const grandDesc = codec.import(grandToken, 12);
      const grandSlave = grandDesc.resource as PtyEndpoint;

      // Exec successor retains independent lifetime for pid 12
      const execToken = execCodec.export(
        { description: grandDesc, resource: grandSlave, rightsBase: 0n, rightsInheriting: 0n },
        12,
      );
      const execDesc = execCodec.import(execToken, 12);
      const execSlave = execDesc.resource as PtyEndpoint;

      // Close parent's slave and child's slave and pre-exec slave: master MUST NOT see EOF while execSlave lives!
      slave.close();
      childDesc.retain();
      childDesc.drop();
      grandDesc.retain();
      grandDesc.drop();
      broker.pump();

      expect(master.readiness().hangup).toBe(false);
      expect(master.tryRead([new Uint8Array(16)])).toBe(-ProcessErrno.AGAIN);

      // execSlave writes and master reads it; resize propagates to execSlave
      expect(execSlave.tryWrite([encoder.encode("alive")])).toBe(5);
      broker.pump();
      const buf = new Uint8Array(16);
      expect(master.tryRead([buf])).toBe(5);
      expect(decoder.decode(buf.subarray(0, 5))).toBe("alive");

      master.resize(120, 40);
      expect(execSlave.size()).toEqual({ cols: 120, rows: 40, seq: 1 });

      // Closing last slave causes natural EOF + hangup on master
      execDesc.retain();
      execDesc.drop();
      broker.pump();
      expect(master.readiness().hangup).toBe(true);
      expect(master.tryRead([new Uint8Array(16)])).toBe(0);

      master.close();
      broker.pump();
      expect(broker.size).toBe(0);
    } finally {
      broker.dispose();
    }
  });

  test("revoking a child process holding slave unblocks master with hangup and discard cleans up", () => {
    const broker = new WorkerPipeBroker({ relay: "manual" });
    const transport = createWorkerProcessTransport({ pid: 20 });
    const host = new WorkerPipeHost({
      transport,
      postMessage(message) {
        if (message.operation === "pipe") broker.attach(message.handle as PipeEndpointHandle);
      },
    });
    host.registry.registerProcess(21);
    host.registry.registerProcess(22);

    try {
      const [master, slave] = host.createPty(80, 24);
      const codec = createRuntimeTerminalCodec({ fallback: host.codec() });

      // Discard path frees retained handles cleanly
      const discardedToken = codec.export(
        { description: {} as any, resource: slave, rightsBase: 0n, rightsInheriting: 0n },
        22,
      );
      codec.discard(discardedToken);

      // Child 21 takes slave, parent drops its slave
      const childToken = codec.export(
        { description: {} as any, resource: slave, rightsBase: 0n, rightsInheriting: 0n },
        21,
      );
      const childDesc = codec.import(childToken, 21);
      slave.close();
      broker.pump();
      expect(master.readiness().hangup).toBe(false);

      // Crash / revoke child 21 without closing its descriptor
      host.revokeProcess(21);
      broker.pump();
      expect(master.readiness().hangup).toBe(true);
      expect(master.tryRead([new Uint8Array(8)])).toBe(0);

      childDesc.retain();
      childDesc.drop();
      master.close();
      broker.pump();
      expect(broker.size).toBe(0);

      // Malformed geometry buffer rejected by attachPtyEndpoint
      expect(() =>
        attachPtyEndpoint({
          role: "slave",
          read: {} as any,
          write: {} as any,
          geometry: new SharedArrayBuffer(PTY_GEOMETRY_BYTES - 4),
        }),
      ).toThrow(TypeError);
    } finally {
      broker.dispose();
    }
  });

  test("concurrent cross-worker resize() and size() never observe torn dimensions or sequence", async () => {
    const broker = new WorkerPipeBroker({ relay: "manual" });
    const transport = createWorkerProcessTransport({ pid: 30 });
    const host = new WorkerPipeHost({
      transport,
      postMessage(message) {
        if (message.operation === "pipe") broker.attach(message.handle as PipeEndpointHandle);
      },
    });
    host.registry.registerProcess(31);
    try {
      const [master, slave] = host.createPty(80, 24);
      const childSlave = slave.forProcess(31);
      const iterations = 5_000;
      const worker = new Worker(new URL("./fixtures/pty-resize-worker.ts", import.meta.url).href, {
        type: "module",
      });
      let workerSettled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          workerSettled = true;
          reject(new Error("pty resize worker timed out"));
        }, 10_000);
        worker.onmessage = () => {
          clearTimeout(timer);
          workerSettled = true;
          resolve();
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          workerSettled = true;
          reject(new Error(event.message || "pty resize worker failed"));
        };
      });
      worker.postMessage({ handle: childSlave.handle(), iterations });
      try {
        await sampleConsistentResizes(master, iterations, () => workerSettled);
        await finished;
        expect(master.size()).toEqual({
          cols: 80 + (iterations % 500),
          rows: 24 + (iterations % 200),
          seq: iterations,
        });
      } finally {
        clearTimeout(timer);
        worker.terminate();
        childSlave.close();
        slave.close();
        master.close();
        broker.pump();
      }
    } finally {
      broker.dispose();
    }
  });
});
