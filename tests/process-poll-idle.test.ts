import { expect, test } from "bun:test";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import { PipeController } from "../proc/pipes.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerDescriptorCodec,
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
  const service = new WorkerProcessClient({
    transport,
    descriptors,
    codec,
    postMessage() {},
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
    descriptors,
    service,
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

test("mixed directory subscriptions park once across multiple idle processes", () => {
  const processes = Array.from({ length: 4 }, () => fixture());
  try {
    for (const process of processes) {
      const { child, job } = process.spawn();
      process.subscribe(0, 0, process.reader);
      process.subscribe(1, 2, child);
      process.subscribe(2, 4, job);
      process.subscribe(3, 6, child);
      expect(process.poll(4, 35)).toBe(0);
      expect(process.waits).toEqual([35]);
    }
  } finally {
    for (const process of processes) process.close();
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
