import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.ts";
import { MemFS } from "../fs/memory.ts";
import { FilesystemError } from "../fs/protocol.ts";
import { ProcessABI, ProcessSignalExit } from "../proc/abi.ts";
import { ProcessSupervisor } from "../proc/supervisor.ts";
import { ExecutableRegistry } from "../proc/registry.ts";
import { ProcessError } from "../proc/types.ts";
import { spawnError } from "../proc/start-failure.ts";
import { describeStartError, START_DIAGNOSTIC_BYTES } from "../proc/start-diagnostic.ts";
import {
  claimOutcome,
  readStartDiagnostic,
  serializeOutcome,
  reviveOutcome,
  outcomeWord,
} from "../proc/outcome.ts";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.ts";
import { WorkerProcessBroker } from "../proc/worker-broker.ts";
import { spawnDiagnosticGuest, spawnDiagnosticSource } from "./fixtures/spawn-diagnostic-guest.ts";
import { InterruptModuleCache } from "../interrupt/loader.ts";
import { isolatedProcess } from "./fixtures/isolated-process.ts";

const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] };
const bytes = new TextEncoder().encode(JSON.stringify(request));
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
function fixture() {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const supervisor = new ProcessSupervisor({ registry, launch: () => ({ terminate() {} }) });
  const root = supervisor.createRoot();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const abi = new ProcessABI({
    memory,
    pid: root,
    service: supervisor,
    descriptors: supervisor.get(root)!.descriptors,
    signals: supervisor.get(root)!,
    fs: new MemFS(),
  });
  new Uint8Array(memory.buffer).set(bytes, 128);
  return { supervisor, root, memory, abi, guest: spawnDiagnosticGuest(abi, memory) };
}
function read(
  guest: ReturnType<typeof spawnDiagnosticGuest>,
  memory: WebAssembly.Memory,
  pid: number,
) {
  const length = guest.spawn_error(pid, 0, 0);
  expect(length).toBeGreaterThanOrEqual(0);
  expect(guest.spawn_error(pid, 8192, length)).toBe(length);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(memory.buffer, 8192, length),
  );
}

test("real guest preserves synchronous errno, original causes, overwrite, clear and caller isolation", () => {
  const f = fixture(),
    other = fixture();
  const original = new Error("worker construction failed", {
    cause: new TypeError("message clone rejected", { cause: "original payload" }),
  });
  const spawn = f.supervisor.spawn.bind(f.supervisor);
  f.supervisor.spawn = () => {
    throw original;
  };
  try {
    expect(f.guest.spawn(128, bytes.length)).toBe(-29);
    const text = read(f.guest, f.memory, 0);
    expect(text).toContain("worker construction failed");
    expect(text).toContain("Caused by: TypeError: message clone rejected");
    expect(text).toContain("original payload");
    expect(read(other.guest, other.memory, 0)).toBe("");
    expect(spawnError(original).cause).toBe(original);
    expect(spawnError(original).message).toBe(original.message);
    f.supervisor.spawn = () => {
      throw new RangeError("allocation refused");
    };
    expect(f.guest.spawn(128, bytes.length)).toBe(-48);
    expect(read(f.guest, f.memory, 0)).toContain("allocation refused");
    expect(read(f.guest, f.memory, 0)).not.toContain("construction failed");
    f.supervisor.spawn = spawn;
    expect(f.guest.spawn(128, bytes.length)).toBeGreaterThan(0);
    expect(read(f.guest, f.memory, 0)).toBe("");
    f.supervisor.dispose();
    expect(f.guest.spawn_error(0, 0, 0)).toBe(-71);
  } finally {
    f.supervisor.dispose();
    other.supervisor.dispose();
  }
});

test("normal source admission accepts the spawn diagnostic import and executes it", async () => {
  const compiled = await new InterruptModuleCache().compile(spawnDiagnosticSource);
  const f = fixture();
  const guest = spawnDiagnosticGuest(f.abi, f.memory, compiled);
  f.supervisor.spawn = () => {
    throw new Error("source admitted original cause");
  };
  try {
    expect(guest.spawn(128, bytes.length)).toBe(-29);
    expect(read(guest, f.memory, 0)).toContain("source admitted original cause");
  } finally {
    f.supervisor.dispose();
  }
});

for (const [error, errno] of [
  [new ProcessError(8, "bad descriptor"), 8],
  [new ProcessError(41, "full"), 6],
  [new FilesystemError(33), 6],
  [new RangeError("allocation"), 48],
  [new Error("ordinary"), 29],
  [null, 29],
  [undefined, 29],
  [17, 29],
  [Symbol("token"), 29],
] as const)
  test(`spawn diagnostics preserve errno ${errno} for ${String(error)}`, () => {
    const f = fixture();
    f.supervisor.spawn = () => {
      throw error;
    };
    try {
      expect(f.guest.spawn(128, bytes.length)).toBe(-errno);
      expect(read(f.guest, f.memory, 0).length).toBeGreaterThan(0);
    } finally {
      f.supervisor.dispose();
    }
  });

test("unknown throws, cycles and throwing accessors cannot mask EIO", () => {
  const hostile = Object.create(null);
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("getter");
    },
  });
  Object.defineProperty(hostile, "code", {
    get() {
      throw new Error("getter");
    },
  });
  hostile.cause = hostile;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const f = fixture();
  try {
    for (const thrown of [hostile, revoked.proxy]) {
      f.supervisor.spawn = () => {
        throw thrown;
      };
      expect(f.guest.spawn(128, bytes.length)).toBe(-29);
      expect(read(f.guest, f.memory, 0)).toContain("[object]");
    }
    expect(describeStartError(hostile)).toContain("[circular cause]");
    const unwind = new ProcessSignalExit(9);
    f.supervisor.spawn = () => {
      throw unwind;
    };
    expect(() => f.guest.spawn(128, bytes.length)).toThrow(unwind);
  } finally {
    f.supervisor.dispose();
  }
});

test("diagnostic guest reads are bounded UTF-8, all-or-nothing and non-consuming", () => {
  const f = fixture();
  let error = new Error("底🙂".repeat(300));
  for (let i = 0; i < 12; i++) error = new Error("底🙂".repeat(300), { cause: error });
  f.supervisor.spawn = () => {
    throw error;
  };
  try {
    expect(f.guest.spawn(128, bytes.length)).toBe(-29);
    const length = f.guest.spawn_error(0, 0, 0);
    expect(length).toBeLessThanOrEqual(START_DIAGNOSTIC_BYTES);
    const sentinel = new Uint8Array(f.memory.buffer, 8192, length + 1);
    sentinel.fill(0xa5);
    expect(f.guest.spawn_error(0, 8192, length - 1)).toBe(length);
    expect(sentinel.every((byte) => byte === 0xa5)).toBe(true);
    expect(read(f.guest, f.memory, 0).length).toBeGreaterThan(0);
    expect(sentinel[length]).toBe(0xa5);
    expect(f.guest.spawn_error(0, 65536, 0)).toBe(length);
    expect(f.guest.spawn_error(0, 65537, 0)).toBe(-21);
    expect(f.guest.spawn_error(0, 65535, 2)).toBe(-21);
    expect(f.abi.imports.spawn_error!(0, NaN, 0)).toBe(-28);
    expect(f.guest.spawn_error(-1, 0, 0)).toBe(-28);
  } finally {
    f.supervisor.dispose();
  }
});

test("host startup details obey child authority and disappear on consuming wait", () => {
  const f = fixture();
  try {
    const pid = f.guest.spawn(128, bytes.length);
    expect(read(f.guest, f.memory, pid)).toBe("");
    f.supervisor.failStart(pid, new Error("loader failed", { cause: new Error("digest failed") }));
    expect(f.abi.imports.start_status!(pid)).toBe(29);
    expect(read(f.guest, f.memory, pid)).toContain("Caused by: Error: digest failed");
    expect(f.guest.spawn_error(f.root, 0, 0)).toBe(-12);
    expect(f.guest.spawn_error(999999, 0, 0)).toBe(-12);
    expect(f.abi.imports.wait!(pid, 64)).toBe(0);
    expect(new DataView(f.memory.buffer).getInt32(68, true)).toBe(29);
    expect(f.guest.spawn_error(pid, 0, 0)).toBe(-12);
  } finally {
    f.supervisor.dispose();
  }
});

test("standalone outcome transfer copies only the winning startup diagnostic", () => {
  const source = outcomeWord(),
    remote = reviveOutcome(structuredClone(serializeOutcome(source)));
  const result = { kind: "start-failed", code: 5 } as const;
  claimOutcome(remote, result, undefined, "worker original cause");
  claimOutcome(source, result, undefined, "late host failure");
  expect(readStartDiagnostic(source)).toBe("worker original cause");
});

test("raw-buffer aliases and cloned transfers share standalone diagnostic publication", () => {
  const f = fixture();
  const word = outcomeWord();
  const alias = outcomeWord(word.buffer as SharedArrayBuffer);
  const remote = reviveOutcome(structuredClone(serializeOutcome(word)));
  try {
    const pid = f.supervisor.reserveSpawn(f.root, request, {
      outcome: alias.buffer as SharedArrayBuffer,
    });
    claimOutcome(remote, { kind: "start-failed", code: 5 }, undefined, "original remote cause");
    f.supervisor.failStart(pid, new Error("later host acknowledgement"));
    expect(readStartDiagnostic(word)).toBe("original remote cause");
    expect(read(f.guest, f.memory, pid)).toBe("original remote cause");
    expect(f.abi.imports.wait!(pid, 64)).toBe(0);
  } finally {
    f.supervisor.dispose();
  }
});

test("failed diagnostic allocation completes publication and does not prevent collection", async () => {
  const isolated = await isolatedProcess();
  const outcomes = isolated.load<typeof import("../proc/outcome.ts")>("outcome");
  const f = fixture();
  const word = outcomes.outcomeWord();
  let attempts = 0;
  isolated.hooks.encodeUtf8Prefix = () => {
    attempts++;
    throw new RangeError("allocation failed");
  };
  try {
    const pid = f.supervisor.reserveSpawn(f.root, request, {
      outcome: word.buffer as SharedArrayBuffer,
    });
    outcomes.claimOutcome(word, { kind: "start-failed", code: 5 }, undefined, "original cause");
    f.supervisor.failStart(pid, new Error("host acknowledgement"));
    expect(attempts).toBe(1);
    expect(outcomes.readStartDiagnostic(word)).toBe("");
    expect(f.abi.imports.start_status!(pid)).toBe(29);
    expect(f.guest.spawn_error(pid, 0, 0)).toBe(0);
    expect(f.abi.imports.wait!(pid, 64)).toBe(0);
    expect(f.guest.spawn_error(pid, 0, 0)).toBe(-12);
  } finally {
    f.supervisor.dispose();
  }
});

test("a terminal publication racing diagnostic copy reports pending rather than an empty error", async () => {
  const isolated = await isolatedProcess();
  const { claimOutcome, outcomeWord, readStartDiagnostic } =
    isolated.load<typeof import("../proc/outcome.ts")>("outcome");
  const word = outcomeWord();
  const compareExchange = isolated.atomics.compareExchange;
  let observed = false;
  isolated.atomics.compareExchange = ((...args: Parameters<typeof compareExchange>) => {
    const previous = Reflect.apply(compareExchange, Atomics, args);
    if (args[0] === word) {
      observed = true;
      expect(readStartDiagnostic(word)).toBeNull();
    }
    return previous;
  }) as typeof compareExchange;
  try {
    claimOutcome(word, { kind: "start-failed", code: 5 }, undefined, "original cause");
    expect(observed).toBe(true);
    expect(readStartDiagnostic(word)).toBe("original cause");
  } finally {
    isolated.atomics.compareExchange = compareExchange;
  }
});

test("diagnostic state belongs to each caller even when they share one supervisor", () => {
  const f = fixture();
  const root = f.supervisor.createRoot(),
    memory = new WebAssembly.Memory({ initial: 1 });
  const abi = new ProcessABI({
    memory,
    pid: root,
    service: f.supervisor,
    descriptors: f.supervisor.get(root)!.descriptors,
    signals: f.supervisor.get(root)!,
    fs: new MemFS(),
  });
  const second = spawnDiagnosticGuest(abi, memory);
  new Uint8Array(memory.buffer).set(bytes, 128);
  f.supervisor.spawn = (pid) => {
    throw new Error(`failure for ${pid}`);
  };
  try {
    expect(f.guest.spawn(128, bytes.length)).toBe(-29);
    expect(read(second, memory, 0)).toBe("");
    expect(second.spawn(128, bytes.length)).toBe(-29);
    expect(read(second, memory, 0)).toContain(`failure for ${root}`);
    expect(read(f.guest, f.memory, 0)).toContain(`failure for ${f.root}`);
    expect(second.spawn_error(f.root, 0, 0)).toBe(-12);
  } finally {
    f.supervisor.dispose();
  }
});

test("broker admission failures reach a blocked guest through shared storage without retention", async () => {
  const root = createWorkerProcessTransport({ pid: 1, job: 1, capacity: 3 });
  const descriptors = new DescriptorTable(),
    notices: WorkerProcessMessage[] = [];
  const codec = {
    export() {
      throw new Error("unused");
    },
    import() {
      throw new Error("unused");
    },
    discard() {},
  };
  const parent = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec,
    postMessage: (message) => notices.push(message),
  });
  const broker = new WorkerProcessBroker({
    codec,
    supervisor: async () => {
      throw new Error("broker activation", { cause: new TypeError("original import") });
    },
  });
  broker.adoptRoot(root);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const abi = new ProcessABI({
    memory,
    pid: parent.pid,
    service: parent,
    descriptors,
    signals: parent.signals,
    fs: new MemFS(),
  });
  const guest = spawnDiagnosticGuest(abi, memory);
  new Uint8Array(memory.buffer).set(bytes, 128);
  try {
    const pid = guest.spawn(128, bytes.length);
    const capturedOutcome = workerProcessState(notices[0]!.transport).signals.outcome;
    await expect(broker.handle(notices[0]!, parent.pid)).rejects.toThrow("broker activation");
    expect(abi.imports.start_status!(pid)).toBe(29);
    expect(read(guest, memory, pid)).toContain("Caused by: TypeError: original import");
    const sibling = createWorkerProcessTransport({ pid: 99, job: 99 });
    expect(guest.spawn_error(sibling.pid, 0, 0)).toBe(-12);
    expect(abi.imports.wait!(pid, 64)).toBe(0);
    expect(guest.spawn_error(pid, 0, 0)).toBe(-12);
    expect(() => readStartDiagnostic(capturedOutcome)).toThrow("collected");
    expect(parent.waitJob(parent.pid, 2)).toMatchObject({ kind: "start-failed", error: "EIO" });
    const replacement = parent.spawn(parent.pid, request);
    expect(() =>
      claimOutcome(capturedOutcome, { kind: "start-failed", code: 5 }, undefined, "stale secret"),
    ).toThrow("collected");
    expect(read(guest, memory, replacement)).toBe("");
    claimOutcome(parent.signals.outcome, { kind: "exited", code: 0 });
    expect(guest.spawn_error(0, 0, 0)).toBe(-71);
  } finally {
    await broker.dispose();
    descriptors.dispose();
  }
});
