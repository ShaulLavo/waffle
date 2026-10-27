import { expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { controlLoad } from "../proc/control.js";
import { WorkerProcessBroker } from "../proc/worker-broker.js";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import { PipeController } from "../proc/pipes.js";
import { claimOutcome } from "../proc/outcome.js";
import {
  confirmWorkerProcessJob,
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerDescriptorCodec,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";

const ALL = (1n << 29n) - 1n;
const INPUT = 256;
const OUTPUT = 512;

function fixture() {
  const transport = createWorkerProcessTransport({ capacity: 4 });
  const descriptors = new DescriptorTable();
  const codec: WorkerDescriptorCodec = {
    export() {
      throw new Error("unexpected descriptor export");
    },
    import() {
      throw new Error("unexpected descriptor import");
    },
    discard() {},
  };
  const messages: WorkerProcessMessage[] = [];
  const service = new WorkerProcessClient({
    transport,
    descriptors,
    codec,
    postMessage(message) {
      messages.push(message);
    },
  });
  const controller = new PipeController({ capacity: 8, wake: service.wake });
  const reader = descriptors.open(controller.retain(service.pid, "read"), ALL, ALL);
  const writer = descriptors.open(controller.retain(service.pid, "write"), ALL, ALL);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const waits: number[] = [];
  let tick = 0;
  let action: (() => void) | undefined;
  const abi = new ProcessABI({
    memory,
    descriptors,
    fs: new MemFS(),
    pid: service.pid,
    service,
    signals: service.signals,
    wake: service.wake,
    now: () => tick,
    wait(milliseconds) {
      waits.push(milliseconds);
      tick += milliseconds;
      action?.();
    },
  });
  const subscribe = (index: number, kind: number, id: number) => {
    const view = new DataView(memory.buffer);
    view.setUint32(INPUT + index * 16, kind, true);
    view.setUint32(INPUT + index * 16 + 4, id, true);
    view.setBigUint64(INPUT + index * 16 + 8, BigInt(index + 1), true);
  };
  const poll = (count: number, timeout: number) => abi.imports.poll!(INPUT, count, timeout, OUTPUT);
  const spawn = () => {
    const child = service.spawn(service.pid, {
      executable: "idle",
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    return { child, job: service.jobOf(child) };
  };
  return {
    abi,
    transport,
    codec,
    descriptors,
    service,
    messages,
    memory,
    reader,
    writer,
    waits,
    subscribe,
    poll,
    spawn,
    act(callback: () => void) {
      action = callback;
    },
    close() {
      descriptors.dispose();
    },
  };
}

test("fully notified mixed subscriptions park once across multiple idle processes", () => {
  const processes = Array.from({ length: 4 }, () => fixture());
  try {
    for (const process of processes) {
      const { child, job } = process.spawn();
      process.subscribe(0, 0, process.reader);
      process.subscribe(1, 2, child);
      process.subscribe(2, 4, job);
      expect(process.poll(3, 35)).toBe(0);
      expect(process.waits).toEqual([35]);
    }
  } finally {
    for (const process of processes) process.close();
  }
});

test("confirmed directory lifecycle publication wakes child and job subscriptions", () => {
  const process = fixture();
  try {
    const { child, job } = process.spawn();
    const message = process.messages.at(-1);
    if (message?.operation !== "spawn") throw new Error("spawn transport missing");
    process.subscribe(0, 2, child);
    process.subscribe(1, 4, job);
    process.act(() => {
      expect(process.waits).toEqual([Infinity]);
      const state = workerProcessState(message.transport);
      claimOutcome(state.signals.outcome, { kind: "exited", code: 23 });
      confirmWorkerProcessJob(message.transport);
    });
    expect(process.poll(2, -1)).toBe(2);
    expect(process.waits).toEqual([Infinity]);
    expect(process.abi.imports.wait!(child, 64)).toBe(0);
    expect(new DataView(process.memory.buffer).getInt32(68, true)).toBe(23);
  } finally {
    process.close();
  }
});

test("common pipe publication wakes an indefinite wait without periodic retries", () => {
  const process = fixture();
  try {
    process.subscribe(0, 0, process.reader);
    process.act(() => {
      expect(process.waits).toEqual([Infinity]);
      new Uint8Array(process.memory.buffer)[4096] = 65;
      expect(process.abi.imports.write!(process.writer, 4096, 1)).toBe(1);
    });
    expect(process.poll(1, -1)).toBe(1);
    expect(process.waits).toEqual([Infinity]);
    expect(process.abi.imports.read!(process.reader, 4096, 1)).toBe(1);
    expect(new Uint8Array(process.memory.buffer)[4096]).toBe(65);
  } finally {
    process.close();
  }
});

test("directory signal cancellation wakes an indefinite wait without consuming delivery", () => {
  const process = fixture();
  try {
    process.subscribe(0, 0, process.reader);
    expect(process.abi.imports.signal!(2, 2)).toBe(0);
    process.act(() => {
      expect(process.waits).toEqual([Infinity]);
      process.service.kill(process.service.pid, 2);
    });
    expect(process.poll(1, -1)).toBe(0);
    expect(process.waits).toEqual([Infinity]);
    expect(process.abi.imports.interrupted!()).toBe(2);
  } finally {
    process.close();
  }
});

test("an independent stream cell retains the bounded readiness fallback", () => {
  const process = fixture();
  const stream: Stream = {
    kind: "pipe",
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: false, writable: false, hangup: false }),
  };
  const fd = process.descriptors.open(stream, ALL, ALL);
  try {
    process.subscribe(0, 0, fd);
    expect(process.poll(1, 25)).toBe(0);
    expect(process.waits).toEqual([10, 10, 5]);
  } finally {
    process.close();
  }
});

test("mixed CHILD_START subscriptions retain bounded rescans across idle processes", () => {
  const processes = Array.from({ length: 4 }, () => fixture());
  try {
    for (const process of processes) {
      const { child, job } = process.spawn();
      process.subscribe(0, 0, process.reader);
      process.subscribe(1, 2, child);
      process.subscribe(2, 4, job);
      process.subscribe(3, 6, child);
      expect(process.poll(4, 35)).toBe(0);
      expect(process.waits).toEqual([10, 10, 10, 5]);
    }
  } finally {
    for (const process of processes) process.close();
  }
});

function workerDeadline() {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("poll missed pre-cleanup startup failure")), 1000);
  });
  return { expired, close: () => clearTimeout(timer) };
}

async function brokerStartupFailure(mixed: boolean) {
  const process = fixture();
  const cleanup = Promise.withResolvers<void>();
  const atFence = Promise.withResolvers<void>();
  const broker = new WorkerProcessBroker({
    supervisor: async () => {
      throw new Error("activation failed");
    },
    codec: process.codec,
    quiesce() {
      atFence.resolve();
      return cleanup.promise;
    },
    onError() {},
  });
  broker.adoptRoot(process.transport);
  const { child } = process.spawn();
  const spawn = process.messages.at(-1);
  if (spawn?.operation !== "spawn") throw new Error("spawn transport missing");
  const worker = new Worker(new URL("./fixtures/process-poll-start-failure.ts", import.meta.url), {
    workerData: { transport: process.transport, childTransport: spawn.transport, child, mixed },
  });
  const deadline = workerDeadline();
  let pending: Promise<unknown> | undefined;
  try {
    const [waiting] = await Promise.race([once(worker, "message"), deadline.expired]);
    expect(waiting).toEqual({ phase: "waiting" });
    const completed = once(worker, "message");
    const sequence = Atomics.load(process.service.wake, 0);
    pending = broker.handle(spawn, process.service.pid).catch((error: unknown) => error);
    await Promise.race([atFence.promise, deadline.expired]);
    const state = workerProcessState(spawn.transport);
    expect(process.service.startStatus(process.service.pid, child)).toBe(29);
    expect(controlLoad(state.confirmed)).toBe(0);
    expect(process.service.childExited(process.service.pid, child)).toBe(false);
    expect(Atomics.load(process.service.wake, 0)).toBe(sequence);
    const [done] = await Promise.race([completed, deadline.expired]);
    expect(done).toMatchObject({
      phase: "done",
      ready: 1,
      eventKind: 6,
      startup: 29,
      confirmed: 0,
      exited: false,
      waitResult: -6,
    });
    expect(done.waits.length).toBeGreaterThan(0);
    expect(done.waits.every((milliseconds: number) => milliseconds === 10)).toBe(true);
    expect(done.nativeWaits.every((result: string) => result === "timed-out")).toBe(true);
    expect(Atomics.load(process.service.wake, 0)).toBe(sequence);
    expect(controlLoad(state.confirmed)).toBe(0);
  } finally {
    deadline.close();
    await worker.terminate();
    cleanup.resolve();
    await pending;
    broker.dispose();
    process.close();
  }
}

test("native CHILD_START poll observes broker failure before cleanup confirmation", () =>
  brokerStartupFailure(false));

test("native mixed poll observes only CHILD_START while broker cleanup is held", () =>
  brokerStartupFailure(true));

function registeredStream(log: string[], label: string, failRegistration = false) {
  return {
    kind: "pipe" as const,
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: false, writable: false, hangup: false }),
    registerWake() {
      if (failRegistration) throw new Error("registration failed");
      log.push(`register:${label}`);
      return () => {
        log.push(`release:${label}`);
      };
    },
  };
}

test("poll registrations span all rescans, deduplicate streams and release in reverse order", () => {
  const process = fixture();
  const log: string[] = [];
  const first = process.descriptors.open(registeredStream(log, "first"), ALL, ALL);
  const second = process.descriptors.open(registeredStream(log, "second"), ALL, ALL);
  try {
    process.subscribe(0, 0, first);
    process.subscribe(1, 0, first);
    process.subscribe(2, 0, second);
    const { child } = process.spawn();
    process.subscribe(3, 6, child);
    process.act(() => {
      expect(log).toEqual(["register:first", "register:second"]);
    });
    expect(process.poll(4, 25)).toBe(0);
    expect(process.waits).toEqual([10, 10, 5]);
    expect(log).toEqual(["register:first", "register:second", "release:second", "release:first"]);
  } finally {
    process.close();
  }
});

test("poll releases earlier registrations when later registration throws", () => {
  const process = fixture();
  const log: string[] = [];
  const first = process.descriptors.open(registeredStream(log, "first"), ALL, ALL);
  const second = process.descriptors.open(registeredStream(log, "second", true), ALL, ALL);
  try {
    process.subscribe(0, 0, first);
    process.subscribe(1, 0, second);
    expect(() => process.poll(2, 25)).toThrow("registration failed");
    expect(log).toEqual(["register:first", "release:first"]);
    expect(process.waits).toEqual([]);
  } finally {
    process.close();
  }
});
