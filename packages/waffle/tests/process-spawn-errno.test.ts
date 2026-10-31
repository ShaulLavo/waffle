import { outcomeWord } from "../proc/outcome.js";
import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { FilesystemError } from "../fs/protocol.js";
import { ProcessABI, type ProcessService } from "../proc/abi.js";
import { createSignalState } from "../proc/signals.js";
import { ProcessError } from "../proc/types.js";

const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] };
for (const [name, error, errno] of [
  ["filesystem identity capacity", new FilesystemError(33), 6],
  ["filesystem capability capacity", new FilesystemError(51), 6],
  ["pipe enrollment capacity", new ProcessError(41, "full"), 6],
  ["allocation", new RangeError("allocation failed"), 48],
  ["bad descriptor", new ProcessError(8, "bad descriptor"), 8],
  ["retired caller", new ProcessError(71, "retired caller"), 71],
  ["collected job", new ProcessError(12, "collected job"), 12],
  ["bad request", new ProcessError(28, "bad request"), 28],
] as const)
  test(`spawn returns ${errno} instead of trapping on ${name}`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptors = new DescriptorTable();
    const service = {
      spawn() {
        throw error;
      },
    } as unknown as ProcessService;
    const abi = new ProcessABI({
      memory,
      descriptors,
      fs: new MemFS(),
      pid: 1,
      service,
      signals: {
        interrupt: new Int32Array(new SharedArrayBuffer(4)),
        signalState: createSignalState(),
        requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
        outcome: outcomeWord(),
      },
    });
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    new Uint8Array(memory.buffer).set(bytes, 64);
    try {
      expect(abi.imports.spawn!(64, bytes.length)).toBe(-errno);
    } finally {
      descriptors.dispose();
    }
  });

test("other ABI calls preserve filesystem errno rather than remapping spawn capacity", () => {
  const descriptors = new DescriptorTable();
  const abi = new ProcessABI({
    memory: new WebAssembly.Memory({ initial: 1 }),
    descriptors,
    fs: new MemFS(),
    pid: 1,
    service: {
      jobOf() {
        throw new FilesystemError(51);
      },
    } as unknown as ProcessService,
    signals: {
      interrupt: new Int32Array(new SharedArrayBuffer(4)),
      signalState: createSignalState(),
      requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
      outcome: outcomeWord(),
    },
  });
  try {
    expect(abi.imports.job_of!(0)).toBe(-51);
  } finally {
    descriptors.dispose();
  }
});

for (const [name, error, errno] of [
  ["allocation during export", new RangeError("allocation failed"), 48],
  ["filesystem capability capacity", new FilesystemError(51), 6],
  ["pipe endpoint capacity", new ProcessError(41, "full"), 6],
] as const)
  test(`failed ${name} rolls back its reserved process and job`, async () => {
    const { WorkerProcessClient, createWorkerProcessTransport, workerProcessState } =
      await import("../proc/worker-client.js");
    const { directorySlots, directoryJobs } = await import("../proc/directory.js");
    const transport = createWorkerProcessTransport({ capacity: 2 });
    const state = workerProcessState(transport);
    const descriptors = new DescriptorTable();
    const fd = descriptors.open({ kind: "directory", handle: 1 }, 0n, 0n);
    let cancelled = 0,
      released = 0,
      posted = 0;
    const service = new WorkerProcessClient({
      transport,
      descriptors,
      codec: {
        export() {
          throw error;
        },
        import() {
          throw new Error("unused");
        },
        discard() {},
      },
      postMessage() {
        posted++;
      },
      prepareSpawn() {
        return {
          cancel() {
            cancelled++;
          },
          release() {
            released++;
          },
        };
      },
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({
      memory,
      descriptors,
      fs: new MemFS(),
      pid: state.pid,
      service,
      signals: state.signals,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...request, fds: [{ child: 3, parent: fd }] }),
    );
    new Uint8Array(memory.buffer).set(bytes, 64);
    try {
      expect(abi.imports.spawn!(64, bytes.length)).toBe(-errno);
      expect({ cancelled, released, posted }).toEqual({ cancelled: 1, released: 1, posted: 0 });
      expect(directorySlots(transport.directory)).toEqual([state.slot]);
      expect(directoryJobs(transport.directory)).toEqual([state.jobSlot]);
    } finally {
      descriptors.dispose();
    }
  });

test("exhausted monotonic process identities are capacity rather than allocation", async () => {
  const { ProcessIdentityAllocator } = await import("../proc/identity.js");
  const identities = new ProcessIdentityAllocator();
  Atomics.store(new Int32Array(identities.buffer), 0, 0x7fffffff);
  expect(() => identities.pid()).toThrow(expect.objectContaining({ errno: 6 }));
});

for (const kind of ["exit", "worker signal", "process signal"] as const)
  test(`spawn preserves ${kind} control flow through both normalization boundaries`, async () => {
    const { WasiExit } = await import("../core/wasi.js");
    const { RuntimeWorkerSignal } = await import("../browser/worker.js");
    const { ProcessSignalExit } = await import("../proc/abi.js");
    const { WorkerProcessClient, createWorkerProcessTransport, workerProcessState } =
      await import("../proc/worker-client.js");
    const error =
      kind === "exit"
        ? new WasiExit(0)
        : kind === "worker signal"
          ? new RuntimeWorkerSignal(9)
          : new ProcessSignalExit(15);
    const transport = createWorkerProcessTransport(),
      state = workerProcessState(transport),
      descriptors = new DescriptorTable();
    const service = new WorkerProcessClient({
      transport,
      descriptors,
      postMessage() {
        throw new Error("must not publish");
      },
      codec: {
        export() {},
        import() {
          throw new Error("unused");
        },
        discard() {},
      },
      prepareSpawn() {
        throw error;
      },
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({
      memory,
      descriptors,
      fs: new MemFS(),
      pid: state.pid,
      service,
      signals: state.signals,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    new Uint8Array(memory.buffer).set(bytes, 64);
    try {
      let caught: unknown;
      try {
        abi.imports.spawn!(64, bytes.length);
      } catch (value) {
        caught = value;
      }
      expect(caught).toBe(error);
    } finally {
      descriptors.dispose();
    }
  });

for (const hook of ["commit", "release"] as const)
  test(`post-publication ${hook} failure reports diagnostics without failing spawn`, async () => {
    const {
      WorkerProcessClient,
      createWorkerProcessTransport,
      workerProcessState,
      confirmWorkerProcessJob,
    } = await import("../proc/worker-client.js");
    const { controlStore } = await import("../proc/control.js");
    const { claimOutcome } = await import("../proc/outcome.js");
    const transport = createWorkerProcessTransport(),
      descriptors = new DescriptorTable();
    const messages: import("../proc/worker-client.js").WorkerProcessMessage[] = [],
      errors: unknown[] = [];
    const failure = new Error(`${hook} failed`);
    const client = new WorkerProcessClient({
      transport,
      descriptors,
      postMessage(message) {
        messages.push(message);
      },
      codec: {
        export() {},
        import() {
          throw new Error("unused");
        },
        discard() {},
      },
      prepareSpawn() {
        return {
          [hook]() {
            throw failure;
          },
        };
      },
      onError(error) {
        errors.push(error);
      },
    });
    try {
      const pid = client.spawn(client.pid, request);
      expect(pid).toBeGreaterThan(client.pid);
      expect(errors).toEqual([failure]);
      const child = messages[0]!.transport,
        state = workerProcessState(child);
      expect(state.pid).toBe(pid);
      claimOutcome(state.signals.outcome, { kind: "exited", code: 0 });
      controlStore(state.confirmed, 0, 1);
      confirmWorkerProcessJob(child);
      const job = state.job;
      expect(client.wait(client.pid, pid)).toMatchObject({ kind: "exited", code: 0 });
      expect(client.waitJob(client.pid, job)).toMatchObject({ kind: "exited", code: 0 });
    } finally {
      descriptors.dispose();
    }
  });
