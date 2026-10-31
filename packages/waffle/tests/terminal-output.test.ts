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
  TerminalOutputBudget,
  type TerminalOutputReader,
  type TerminalOutputWriterOptions,
} from "../browser/terminal-output.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { setSignalDisposition, SignalDisposition } from "../proc/signals.js";
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

/** One writer under its own root budget, like a launched Worker before its first write. */
function single(capacity = 65536, options: Partial<TerminalOutputWriterOptions> = {}) {
  const budget = new TerminalOutputBudget(capacity);
  const reader = createTerminalOutput(capacity);
  budget.readers.add(reader);
  const writer = attachTerminalOutput(reader.buffer, { ...activeWriter, ...options });
  return { budget, reader, writer };
}

/** The same writer after the page granted its whole budget. */
function granted(capacity: number, options: Partial<TerminalOutputWriterOptions> = {}) {
  const pair = single(capacity, options);
  pair.reader.grant(capacity);
  return pair;
}

const accept = (_target: 1 | 2, data: Uint8Array) => data.length;

describe("bounded terminal output buffer", () => {
  test("400000 bytes reach a 262144-byte destination exactly, with no drops", () => {
    let doorbells = 0;
    const { budget, reader, writer } = single(65536, { doorbell: () => doorbells++ });
    const terminal = new BoundedTerminal();
    let written = 0,
      blocked = 0;
    while (written < SIZE) {
      const count = writer.tryWrite(1, [expected.subarray(written)]);
      if (count === -6) {
        // Out of credit: the page delivers what it can and grants the freed credit.
        expect(writer.writable()).toBe(false);
        budget.service((_target, data) => terminal.tryWrite(data));
        if (reader.pending() && terminal.queuedBytes === RING) {
          blocked++;
          terminal.drain();
        }
        continue;
      }
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(65536 - 4);
      expect(budget.available()).toBeGreaterThanOrEqual(0);
      written += count;
    }
    while (reader.pending()) {
      terminal.drain();
      budget.service((_target, data) => terminal.tryWrite(data));
    }
    expect(blocked).toBeGreaterThan(0);
    expect(doorbells).toBeGreaterThan(0);
    expect(terminal.bytes()).toEqual(expected);
  });

  test("a credit request that lands after its grant leaves the next write's doorbell armed", () => {
    // Firefox, Bun 370 process gate: the writer's readiness check read credit 0, the page
    // granted the whole budget, then the writer stored its request. The page's park took that
    // stale request as work, disarmed, found no credit to give and stopped. The exit flush then
    // waited on 34 undelivered bytes that never rang: [34,0,1,0,0,65502,1,0].
    const delivered: number[] = [];
    let doorbells = 0,
      answering = false;
    const pair = single(65536, {
      doorbell() {
        doorbells++;
        if (answering)
          pair.budget.service((_target, data) => delivered.push(...data) && data.length);
      },
    });
    const { reader, writer } = pair;
    const state = new Int32Array(reader.buffer, 0, 8);
    // AGAIN records the request and rings the arm; the page answers it below.
    expect(writer.tryWrite(1, [Uint8Array.of(1)])).toBe(-6);
    answering = true;
    expect(doorbells).toBe(1);
    expect(Array.from(state)).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    // The page's pass grants the whole budget; the late request (want, then the spent arm)
    // lands before that pass parks.
    reader.grant(65536);
    Atomics.store(state, 6, 1);
    expect(Atomics.exchange(state, 3, 0)).toBe(0);
    pair.budget.service(accept);
    expect(writer.tryWrite(1, [new Uint8Array(13).fill(7)])).toBe(13);
    expect(writer.tryWrite(2, [new Uint8Array(13).fill(8)])).toBe(13);
    let checks = 0;
    expect(writer.flush(() => ++checks > 3)).toBe(true);
    // Each write rang: the page delivered it and armed again.
    expect(doorbells).toBe(3);
    expect(delivered).toEqual(Array(13).fill(7).concat(Array(13).fill(8)));
    expect(reader.wants()).toBe(false);
  });

  test("short deliveries keep the rest buffered in order, across targets", () => {
    const { reader, writer } = granted(64);
    expect(writer.tryWrite(1, [Uint8Array.of(1, 2, 3), Uint8Array.of(4)])).toBe(4);
    expect(writer.tryWrite(2, [Uint8Array.of(5, 6)])).toBe(2);
    const seen: [number, number[]][] = [];
    let room = 3;
    const deliver = (target: 1 | 2, data: Uint8Array) => {
      const count = Math.min(room, data.length);
      room -= count;
      if (count) seen.push([target, Array.from(data.subarray(0, count))]);
      return count;
    };
    expect(reader.drain(deliver)).toBe("blocked");
    expect(reader.pending()).toBe(4 + 1 + 4 + 2);
    room = 100;
    expect(reader.drain(deliver)).toBe("idle");
    expect(seen).toEqual([
      [1, [1, 2, 3]],
      [1, [4]],
      [2, [5, 6]],
    ]);
    // The arm consumed by the next write rings exactly one doorbell.
    expect(reader.park()).toBe(true);
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
    const { budget, reader, writer } = granted(64);
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
      budget.service(deliver);
      expect(reader.drain(deliver)).toBe("blocked");
      return 1;
    };
    expect(reader.drain(deliver)).toBe("blocked");
    expect(seen).toEqual([1]);
    budget.service(deliver);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(reader.pending()).toBe(0);
  });

  test("a reentrant drain while the destination accepts nothing returns at once", () => {
    // R733: a destination that reports room from inside a refused delivery used to spin.
    const { budget, reader, writer } = granted(16);
    writer.tryWrite(1, [Uint8Array.of(1)]);
    let calls = 0;
    const deliver = () => {
      calls++;
      if (calls > 3) throw new Error("drain spun without progress");
      budget.service(deliver);
      reader.drain(deliver);
      return 0;
    };
    budget.service(deliver);
    expect(calls).toBe(1);
    expect(reader.drain(deliver)).toBe("blocked");
    expect(calls).toBe(2);
    expect(reader.pending()).toBe(5);
  });

  test("capacity is a power of two, so wrapped positions stay consistent", () => {
    for (const capacity of [0, 4, 24, 65535, 2 ** 31])
      expect(() => createTerminalOutput(capacity)).toThrow(RangeError);
    const { budget, reader, writer } = single(8);
    // Start just below the 32-bit wrap: every record crosses it at some point.
    const state = new Int32Array(reader.buffer, 0, 2);
    state[0] = state[1] = -6;
    const seen: number[] = [];
    for (let value = 0; value < 8; value++) {
      if (writer.tryWrite(1, [Uint8Array.of(value, value + 100)]) === -6) budget.service(accept);
      expect(writer.tryWrite(1, [Uint8Array.of(value, value + 100)])).toBe(2);
      budget.service((_target, data) => seen.push(...data) && data.length);
    }
    expect(seen).toEqual(Array.from({ length: 8 }, (_, value) => [value, value + 100]).flat());
  });

  test("a full buffer refuses with AGAIN and never reports more than it accepted", () => {
    const { budget, reader, writer } = granted(16);
    expect(writer.tryWrite(1, [new Uint8Array(100)])).toBe(12);
    expect(writer.tryWrite(1, [new Uint8Array(1)])).toBe(-6);
    expect(writer.writable()).toBe(false);
    expect(reader.wants()).toBe(true);
    expect(reader.pending()).toBe(16);
    expect(budget.available()).toBe(0);
  });

  test("an interrupted blocking write returns its accepted prefix, or EINTR before any", () => {
    let interrupted = false;
    const { reader, writer } = granted(16, { interrupted: () => interrupted });
    interrupted = true;
    expect(writer.write(1, [new Uint8Array(20)])).toBe(12);
    expect(writer.write(1, [new Uint8Array(20)])).toBe(-27);
    expect(reader.pending()).toBe(16);
  });

  test("close and revocation stop writers without discarding accepted bytes", () => {
    let active = true;
    const { reader, writer } = granted(16, {
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
    const { reader, writer } = granted(16);
    expect(writer.flush(() => false)).toBe(true);
    writer.tryWrite(1, [Uint8Array.of(1)]);
    expect(writer.flush(() => true)).toBe(false);
    reader.drain(accept);
    expect(writer.flush(() => false)).toBe(true);
  });

  test("an invalid delivery count fails loudly and keeps the bytes", () => {
    const { reader, writer } = granted(16);
    writer.tryWrite(1, [Uint8Array.of(1, 2)]);
    for (const count of [3, -1, 0.5, Number.NaN]) {
      const deliver = () => count;
      expect(() => reader.drain(deliver)).toThrow("invalid count");
    }
    expect(reader.pending()).toBe(6);
  });

  test("a throwing destination keeps the exact record for a later delivery", () => {
    const { reader, writer } = granted(16);
    writer.tryWrite(2, [Uint8Array.of(1, 2, 3)]);
    const fail = () => {
      throw new Error("destination threw");
    };
    expect(() => reader.drain(fail)).toThrow("destination threw");
    expect(reader.pending()).toBe(7);
    const received: number[] = [];
    reader.drain((target, data) => received.push(target, ...data) && data.length);
    expect(received).toEqual([2, 1, 2, 3]);
  });

  test("the generic codec fallback writes through the bounded buffer with exact counts", () => {
    const { budget, writer } = granted(16);
    const codec = createRuntimeTerminalCodec({ fallback: createWorkerPipeCodec(), output: writer });
    const stream = codec.import({ kind: "web-terminal", target: 2 }, 2).resource as Stream;
    expect(stream.notification).toBeInstanceOf(Int32Array);
    expect(stream.tryWrite!([new Uint8Array(20)])).toBe(12);
    expect(stream.readiness().writable).toBe(false);
    expect(stream.tryWrite!([new Uint8Array(1)])).toBe(-6);
    const targets: number[] = [];
    const seen = Atomics.load(stream.notification!, 0);
    budget.service((target, data) => targets.push(target) && data.length);
    expect(targets).toEqual([2]);
    // Readiness asked for credit; the grant notified the stream's readiness word.
    expect(Atomics.load(stream.notification!, 0)).not.toBe(seen);
    expect(stream.readiness().writable).toBe(true);
  });
});

describe("root terminal output budget", () => {
  test("writers share one budget and an idle writer's credit moves to one that waits", () => {
    const budget = new TerminalOutputBudget(64);
    const readers = [createTerminalOutput(64), createTerminalOutput(64)];
    for (const reader of readers) budget.readers.add(reader);
    const [first, second] = readers.map((reader) =>
      attachTerminalOutput(reader.buffer, activeWriter),
    );
    expect(first!.tryWrite(1, [Uint8Array.of(1)])).toBe(-6);
    budget.service(accept);
    expect(readers[0]!.granted).toBe(64);
    expect(second!.tryWrite(1, [Uint8Array.of(2)])).toBe(-6);
    budget.service(accept);
    expect(readers[0]!.granted + readers[1]!.granted).toBeLessThanOrEqual(64);
    expect(second!.tryWrite(1, [new Uint8Array(100)])).toBe(60);
    expect(first!.tryWrite(1, [Uint8Array.of(1)])).toBe(-6);
    expect(budget.available()).toBe(0);
  });

  test("a stopped writer's accepted bytes stay owned by the root, within one budget", () => {
    // R733: every stopped writer used to keep its whole buffer. Now the root's budget bounds
    // them all, and later writers wait for credit instead of taking new storage.
    const budget = new TerminalOutputBudget(64);
    const stopped: { reader: ReturnType<typeof createTerminalOutput>; accepted: number }[] = [];
    for (let index = 0; index < 8; index++) {
      const reader = createTerminalOutput(64);
      budget.readers.add(reader);
      const writer = attachTerminalOutput(reader.buffer, activeWriter);
      expect(writer.tryWrite(1, [Uint8Array.of(index)])).toBe(-6);
      budget.service(() => 0);
      const accepted = Math.max(0, writer.tryWrite(1, [new Uint8Array(100).fill(index)]));
      budget.service(() => 0);
      reader.retire();
      budget.service(() => 0);
      stopped.push({ reader, accepted });
      expect(() => reader.buffer).toThrow("retired");
      expect(budget.pending()).toBeLessThanOrEqual(64);
      expect(budget.available()).toBeGreaterThanOrEqual(0);
    }
    // Only the first writer got credit; it was promised 60 bytes and keeps them.
    expect(stopped.map(({ accepted }) => accepted)).toEqual([60, 0, 0, 0, 0, 0, 0, 0]);
    expect(budget.readers.size).toBe(1);
    expect(budget.pending()).toBe(64);
    const delivered: number[] = [];
    budget.service((_target, data) => delivered.push(...data) && data.length);
    expect(delivered).toEqual(Array(60).fill(0));
    expect(budget.readers.size).toBe(0);
    expect(budget.available()).toBe(64);
  });

  test("retiring a writer returns credit lost to an unpublished write", () => {
    const { budget, reader, writer } = granted(64);
    expect(writer.tryWrite(1, [Uint8Array.of(1, 2)])).toBe(2);
    // A Worker stopped between taking credit and publishing its record.
    const state = new Int32Array(reader.buffer);
    Atomics.sub(state, 5, 20);
    reader.retire();
    expect(reader.granted).toBe(6);
    expect(budget.available()).toBe(58);
    const delivered: number[] = [];
    budget.service((_target, data) => delivered.push(...data) && data.length);
    expect(delivered).toEqual([1, 2]);
    expect(budget.available()).toBe(64);
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

/** The broker's own bookkeeping, read by the retention regression. */
interface BrokerOutputs {
  readonly children: Map<number, { output?: TerminalOutputReader }>;
  readonly terminalOutputs: Map<number, TerminalOutputBudget>;
}

describe("generic preview1 Worker terminal output", () => {
  let runtime: Runtime;
  let broker: BrokerOutputs;
  beforeEach(() => {
    runtime = createRuntime({
      filesystem: {
        mode: "memory",
        workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
      },
      processHost: (options) => {
        const created = new BrowserProcessBroker(options);
        broker = created as unknown as BrokerOutputs;
        return created;
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
  async function root(destination: {
    tryOutput?: Pick<BoundedTerminal, "tryWrite">;
    output?: Uint8Array[];
  }) {
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
      /** The raw parent wait a shell uses: consumes the exit and frees the slot. */
      reap: (child: number) => client.wait(pid, child),
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

  test("a handled signal ends a blocked write with exactly its accepted prefix", async () => {
    let open = false;
    const offered: Uint8Array[] = [];
    const shell = await root({
      tryOutput: {
        tryWrite(data: Uint8Array) {
          if (!open) return 0;
          offered.push(data.slice());
          return data.length;
        },
      },
    });
    try {
      const child = await shell.spawn();
      await until(() => broker.children.get(child)?.output?.pending() === 65536, "a full budget");
      const state = shell.supervisor.get(child)!;
      setSignalDisposition(state.signalState, 15, SignalDisposition.HANDLE);
      await shell.service.kill(child, 15);
      // fd_write returns its 65532-byte prefix; the guest exits 1 for the short count only
      // after the page delivered it.
      await Bun.sleep(50);
      expect(shell.reap(child)).toBe(null);
      open = true;
      shell.service.outputDrained(shell.pid);
      expect(await shell.supervisor.waitForExit(shell.pid, child)).toMatchObject({
        kind: "exited",
        code: 1,
      });
      expect(Buffer.concat(offered)).toEqual(Buffer.from(expected.subarray(0, 65532)));
    } finally {
      shell.dispose();
    }
  }, 20_000);

  test("killed and reaped writers keep at most one budget of accepted output", async () => {
    // R733: eight blocked children killed, reaped and physically stopped used to keep eight
    // full buffers. The root's budget now holds every accepted byte, and later writers wait.
    let open = false;
    const offered: Uint8Array[] = [];
    const shell = await root({
      tryOutput: {
        tryWrite(data: Uint8Array) {
          if (!open) return 0;
          offered.push(data.slice());
          return data.length;
        },
      },
    });
    try {
      for (let index = 0; index < 8; index++) {
        const child = await shell.spawn();
        const output = () => broker.children.get(child)?.output;
        // The first writer fills the budget; every later one waits for credit before storing.
        await until(
          () => (index ? !!output()?.wants() : output()?.pending() === 65536),
          "a blocked writer",
        );
        await shell.service.kill(child, 9);
        expect(await shell.supervisor.waitForExit(shell.pid, child)).toMatchObject({
          kind: "signaled",
          code: 9,
        });
        shell.reap(child);
        await until(() => !broker.children.has(child), "physical stop");
        const budget = broker.terminalOutputs.get(shell.pid)!;
        expect(broker.children.size).toBe(0);
        expect(budget.readers.size).toBe(1);
        expect(budget.pending()).toBe(65536);
        expect(budget.available()).toBe(0);
      }
      open = true;
      shell.service.outputDrained(shell.pid);
      // Exactly what the first writer was promised: one record's payload, no more, no less.
      expect(Buffer.concat(offered)).toEqual(Buffer.from(expected.subarray(0, 65532)));
      expect(broker.terminalOutputs.has(shell.pid)).toBe(false);
    } finally {
      shell.dispose();
    }
  }, 30_000);

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
