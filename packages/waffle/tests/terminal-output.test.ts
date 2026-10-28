import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRuntime, type Runtime } from "../index.js";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import {
  attachTerminal,
  createRuntimeTerminalCodec,
  createTerminalSession,
  type TerminalPolicy,
} from "../browser/runtime-terminals.js";
import {
  attachTerminalOutput,
  createTerminalOutput,
  type TerminalOutputWriterOptions,
} from "../browser/terminal-output.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { wasiWrite, writePattern } from "./fixtures/wasi-write.js";

// The Shell #168 case: one 400000-byte write into Shell's 262144-byte terminal ring.
const SIZE = 400000;
const RING = 262144;
const expected = writePattern(SIZE);

/** A page terminal ring like Shell's SharedBridge: it accepts only free space. */
class BoundedTerminal {
  private queued: Uint8Array[] = [];
  private size = 0;
  readonly received: Uint8Array[] = [];
  offered = 0;
  tryWrite(data: Uint8Array): number {
    this.offered++;
    const count = Math.min(data.length, RING - this.size);
    if (count) this.queued.push(data.slice(0, count));
    this.size += count;
    return count;
  }
  get queuedBytes(): number {
    return this.size;
  }
  /** The display reads everything queued. */
  drain(): void {
    this.received.push(...this.queued);
    this.queued = [];
    this.size = 0;
  }
  bytes(): Uint8Array {
    return Buffer.concat(this.received.concat(this.queued));
  }
}

const activeWriter: TerminalOutputWriterOptions = {
  checkActive() {},
  interrupted: () => false,
  doorbell() {},
};

describe("bounded terminal output buffer", () => {
  test("400000 bytes reach a 262144-byte destination exactly, with no drops", () => {
    const reader = createTerminalOutput();
    let doorbells = 0;
    const writer = attachTerminalOutput(reader.buffer, {
      ...activeWriter,
      doorbell: () => doorbells++,
    });
    const terminal = new BoundedTerminal();
    let written = 0,
      blocked = 0;
    while (written < SIZE) {
      const count = writer.tryWrite(1, [expected.subarray(written)]);
      if (count === -6) {
        // Writer full: the page drains into the destination. A full destination blocks it.
        expect(writer.writable()).toBe(false);
        if (reader.drain((_target, data) => terminal.tryWrite(data)) === "blocked") {
          blocked++;
          terminal.drain();
        }
        continue;
      }
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(65536 - 4);
      written += count;
    }
    while (reader.drain((_target, data) => terminal.tryWrite(data)) === "blocked") terminal.drain();
    expect(reader.pending()).toBe(0);
    expect(blocked).toBeGreaterThan(0);
    expect(doorbells).toBeGreaterThan(0);
    expect(terminal.bytes()).toEqual(expected);
  });

  test("short deliveries keep the rest buffered in order, across targets", () => {
    const reader = createTerminalOutput(64);
    const writer = attachTerminalOutput(reader.buffer, activeWriter);
    expect(writer.tryWrite(1, [Uint8Array.of(1, 2, 3), Uint8Array.of(4)])).toBe(4);
    expect(writer.tryWrite(2, [Uint8Array.of(5, 6)])).toBe(2);
    const seen: [number, number[]][] = [];
    let budget = 3;
    const deliver = (target: 1 | 2, data: Uint8Array) => {
      const count = Math.min(budget, data.length);
      budget -= count;
      if (count) seen.push([target, Array.from(data.subarray(0, count))]);
      return count;
    };
    expect(reader.drain(deliver)).toBe("blocked");
    expect(reader.pending()).toBe(4 + 1 + 4 + 2);
    budget = 100;
    expect(reader.drain(deliver)).toBe("idle");
    expect(seen).toEqual([
      [1, [1, 2, 3]],
      [1, [4]],
      [2, [5, 6]],
    ]);
    // The arm consumed by the next write rings exactly one doorbell.
    let doorbells = 0;
    const armed = attachTerminalOutput(reader.buffer, {
      ...activeWriter,
      doorbell: () => doorbells++,
    });
    armed.tryWrite(1, [Uint8Array.of(7)]);
    armed.tryWrite(1, [Uint8Array.of(8)]);
    expect(doorbells).toBe(1);
  });

  test("a destination reporting room from inside its delivery does not reenter a record", () => {
    const reader = createTerminalOutput(64);
    const writer = attachTerminalOutput(reader.buffer, activeWriter);
    writer.tryWrite(1, [Uint8Array.of(1, 2, 3, 4)]);
    const seen: number[] = [];
    let first = true;
    const deliver = (_target: 1 | 2, data: Uint8Array): number => {
      if (!first) {
        seen.push(...data);
        return data.length;
      }
      first = false;
      seen.push(data[0]!);
      expect(reader.drain(deliver)).toBe("idle");
      return 1;
    };
    expect(reader.drain(deliver)).toBe("idle");
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(reader.pending()).toBe(0);
  });

  test("capacity is a power of two, so wrapped positions stay consistent", () => {
    for (const capacity of [0, 4, 24, 65535, 2 ** 31])
      expect(() => createTerminalOutput(capacity)).toThrow(RangeError);
    const reader = createTerminalOutput(8);
    const writer = attachTerminalOutput(reader.buffer, activeWriter);
    // Start just below the 32-bit wrap: every record crosses it at some point.
    const state = new Int32Array(reader.buffer, 0, 2);
    state[0] = state[1] = -6;
    const seen: number[] = [];
    for (let value = 0; value < 8; value++) {
      expect(writer.tryWrite(1, [Uint8Array.of(value, value + 100)])).toBe(2);
      reader.drain((_target, data) => seen.push(...data) && data.length);
    }
    expect(seen).toEqual(Array.from({ length: 8 }, (_, value) => [value, value + 100]).flat());
  });

  test("a full buffer refuses with AGAIN and never reports more than it accepted", () => {
    const reader = createTerminalOutput(16);
    const writer = attachTerminalOutput(reader.buffer, activeWriter);
    expect(writer.tryWrite(1, [new Uint8Array(100)])).toBe(12);
    expect(writer.tryWrite(1, [new Uint8Array(1)])).toBe(-6);
    expect(writer.writable()).toBe(false);
    expect(reader.pending()).toBe(16);
  });

  test("an interrupted blocking write returns its accepted prefix, or EINTR before any", () => {
    const reader = createTerminalOutput(16);
    let interrupted = false;
    const writer = attachTerminalOutput(reader.buffer, {
      ...activeWriter,
      interrupted: () => interrupted,
    });
    interrupted = true;
    expect(writer.write(1, [new Uint8Array(20)])).toBe(12);
    expect(writer.write(1, [new Uint8Array(20)])).toBe(-27);
    expect(reader.pending()).toBe(16);
  });

  test("close and revocation stop writers without discarding accepted bytes", () => {
    const reader = createTerminalOutput(16);
    let active = true;
    const writer = attachTerminalOutput(reader.buffer, {
      ...activeWriter,
      checkActive() {
        if (!active) throw new Error("revoked");
      },
    });
    expect(writer.tryWrite(1, [Uint8Array.of(9, 9)])).toBe(2);
    reader.close();
    expect(writer.tryWrite(1, [Uint8Array.of(1)])).toBe(-8);
    expect(writer.write(1, [Uint8Array.of(1)])).toBe(-8);
    expect(writer.flush(() => false)).toBe(false);
    active = false;
    expect(() => writer.tryWrite(1, [Uint8Array.of(1)])).toThrow("revoked");
    const delivered: number[] = [];
    expect(reader.drain((_target, data) => delivered.push(...data) && data.length)).toBe("idle");
    expect(delivered).toEqual([9, 9]);
  });

  test("flush waits for delivery and gives up when stopped", () => {
    const reader = createTerminalOutput(16);
    const writer = attachTerminalOutput(reader.buffer, activeWriter);
    expect(writer.flush(() => false)).toBe(true);
    writer.tryWrite(1, [Uint8Array.of(1)]);
    expect(writer.flush(() => true)).toBe(false);
    reader.drain((_target, data) => data.length);
    expect(writer.flush(() => false)).toBe(true);
  });

  test("an invalid delivery count fails loudly and keeps the bytes", () => {
    const reader = createTerminalOutput(16);
    attachTerminalOutput(reader.buffer, activeWriter).tryWrite(1, [Uint8Array.of(1, 2)]);
    for (const count of [3, -1, 0.5, Number.NaN]) {
      const deliver = () => count;
      expect(() => reader.drain(deliver)).toThrow("invalid count");
    }
    expect(reader.pending()).toBe(6);
  });

  test("the generic codec fallback writes through the bounded buffer with exact counts", () => {
    const reader = createTerminalOutput(16);
    const codec = createRuntimeTerminalCodec({
      fallback: createWorkerPipeCodec(),
      output: attachTerminalOutput(reader.buffer, activeWriter),
    });
    const stream = codec.import({ kind: "web-terminal", target: 2 }, 2).resource as Stream;
    expect(stream.notification).toBeInstanceOf(Int32Array);
    expect(stream.tryWrite!([new Uint8Array(20)])).toBe(12);
    expect(stream.readiness().writable).toBe(false);
    expect(stream.tryWrite!([new Uint8Array(1)])).toBe(-6);
    const targets: number[] = [];
    reader.drain((target, data) => targets.push(target) && data.length);
    expect(targets).toEqual([2]);
    expect(stream.readiness().writable).toBe(true);
  });
});

test("the resolved terminal session path reports exact accepted prefixes to a bounded policy", () => {
  const root = createWorkerProcessTransport({ capacity: 4 });
  const terminal = new BoundedTerminal();
  const policy: TerminalPolicy = {
    inputReadiness: () => ({ readable: false, nbytes: 0 }),
    tryRead: () => -6,
    transition: () => ({ kind: "ok", value: undefined }),
    tryWrite: (_target, chunks) => terminal.tryWrite(Buffer.concat(chunks)) || -6,
    outputReadiness: () => ({ writable: terminal.queuedBytes < RING }),
  };
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const attachment = attachTerminal({
    context: display.inherit(),
    process: root,
    checkActive() {},
    policy,
  });
  try {
    const output = attachment.resolve(1);
    let written = 0,
      refusals = 0;
    while (written < SIZE) {
      const count = output.tryWrite!([expected.subarray(written)]);
      if (count === -6) {
        refusals++;
        expect(output.readiness().writable).toBe(false);
        const seen = Atomics.load(output.notification!, 0);
        terminal.drain();
        display.outputDrained();
        expect(Atomics.load(output.notification!, 0)).not.toBe(seen);
        continue;
      }
      expect(count).toBeGreaterThan(0);
      written += count;
    }
    expect(written).toBe(SIZE);
    expect(refusals).toBe(1);
    expect(terminal.bytes()).toEqual(expected);
  } finally {
    attachment.dispose();
    display.close("disposed");
  }
});

describe("generic preview1 Worker terminal output", () => {
  let runtime: Runtime;
  beforeEach(() => {
    runtime = createRuntime({
      filesystem: {
        mode: "memory",
        workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
      },
    });
    const workerUrl = new URL("../browser/preview1-worker.ts", import.meta.url).href;
    runtime.registerAdapter("preview1", (context, service) =>
      service.launchWorker(context, {
        workerUrl,
        request: { module: context.module, args: context.request.argv, env: {} },
      }),
    );
    runtime.registerProgram("/bin/writer", { adapter: "preview1", source: wasiWrite(SIZE) });
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  /** A runtime root whose fd 1 is a host terminal; children inherit it as a terminal token. */
  async function root(destination: { tryOutput?: BoundedTerminal; output?: Uint8Array[] }) {
    await runtime.filesystem.writeFile("/bin/writer", "");
    const service = await runtime.processes();
    const transport = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
    });
    transport.data = { filesystem: runtime.filesystem.createIdentity() };
    const bounded = destination.tryOutput;
    await service.adoptRuntimeRoot(
      transport,
      bounded
        ? { tryOutput: (_fd, data) => bounded.tryWrite(data) }
        : { output: (_fd, data) => destination.output!.push(data.slice()) },
    );
    const descriptors = new DescriptorTable();
    const unused = () => -58;
    const terminal: Stream = {
      kind: "terminal",
      read: () => 0,
      write: unused,
      readiness: () => ({ readable: false, writable: true, hangup: false }),
    };
    descriptors.openAt(1, terminal, 64n, 0n);
    const notices: WorkerProcessMessage[] = [];
    const client = new WorkerProcessClient({
      transport,
      descriptors,
      codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
      prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
      postMessage: (message) => notices.push(message),
    });
    const supervisor = await service.ready();
    const pid = transport.pid;
    return {
      service,
      supervisor,
      pid,
      dispose: () => descriptors.dispose(),
      async spawn() {
        const fds = [{ parent: 1, child: 1 }];
        const child = client.spawn(pid, {
          executable: "/bin/writer",
          argv: ["writer"],
          env: {},
          cwd: "/",
          job: -1,
          fds,
        });
        while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
        await supervisor.start(child);
        return child;
      },
    };
  }

  async function until(condition: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(2);
    }
  }

  test("a 400000-byte write waits for a 262144-byte destination and loses nothing", async () => {
    const terminal = new BoundedTerminal();
    const shell = await root({ tryOutput: terminal });
    try {
      const child = await shell.spawn();
      let exited = false;
      const exit = shell.supervisor.waitForExit(shell.pid, child).then((result) => {
        exited = true;
        // Exit becomes visible only after every byte reached the destination.
        expect(terminal.bytes().length).toBe(SIZE);
        return result;
      });
      // Nobody reads the display yet: the destination fills and the guest stays in fd_write.
      await until(() => terminal.queuedBytes === RING, "a full destination");
      await Bun.sleep(100);
      expect(exited).toBe(false);
      expect(terminal.queuedBytes).toBe(RING);
      // The display reads like Shell's 2 ms harness, then reports room to Waffle.
      const display = setInterval(() => {
        terminal.drain();
        shell.service.outputDrained(shell.pid);
      }, 2);
      try {
        expect(await exit).toMatchObject({ kind: "exited", code: 0 });
      } finally {
        clearInterval(display);
      }
      expect(terminal.bytes()).toEqual(expected);
    } finally {
      shell.dispose();
    }
  }, 20_000);

  test("an unbounded root destination still receives every byte", async () => {
    const output: Uint8Array[] = [];
    const shell = await root({ output });
    try {
      const child = await shell.spawn();
      expect(await shell.supervisor.waitForExit(shell.pid, child)).toMatchObject({
        kind: "exited",
        code: 0,
      });
      expect(Buffer.concat(output)).toEqual(Buffer.from(expected));
    } finally {
      shell.dispose();
    }
  }, 20_000);

  test("a writer blocked on a full destination stops on SIGKILL and keeps an exact prefix", async () => {
    const terminal = new BoundedTerminal();
    const shell = await root({ tryOutput: terminal });
    try {
      const child = await shell.spawn();
      await until(() => terminal.queuedBytes === RING, "a full destination");
      await shell.service.kill(child, 9);
      expect(await shell.supervisor.waitForExit(shell.pid, child)).toMatchObject({
        kind: "signaled",
        code: 9,
      });
      // Bytes the guest handed over before the kill are still delivered, in order.
      terminal.drain();
      shell.service.outputDrained(shell.pid);
      const bytes = terminal.bytes();
      expect(bytes.length).toBeGreaterThanOrEqual(RING);
      expect(bytes.length).toBeLessThan(SIZE);
      expect(bytes).toEqual(expected.subarray(0, bytes.length));
    } finally {
      shell.dispose();
    }
  }, 20_000);

  test("runtime disposal stops a writer blocked on a full destination", async () => {
    const terminal = new BoundedTerminal();
    const shell = await root({ tryOutput: terminal });
    try {
      await shell.spawn();
      await until(() => terminal.queuedBytes === RING, "a full destination");
      await runtime.dispose();
      expect(runtime.disposed).toBe(true);
    } finally {
      shell.dispose();
    }
  }, 20_000);
});
