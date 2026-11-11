import { expect, spyOn, test } from "bun:test";
import { bootstrap, RuntimeWorkerSignal } from "../browser/worker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { WasiExit } from "../core/index.js";
import { createFilesystemConnection, sharedRevoked } from "../fs/index.js";
import { ProcessSignalExit } from "../proc/abi.js";
import { TaggedCells } from "../proc/control.js";
import { collectDirectoryProcess, confirmDirectoryProcess } from "../proc/directory.js";
import { claimOutcome, OutcomeCell, readOutcome } from "../proc/outcome.js";
import { ProcessError } from "../proc/errors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { standaloneRuntimeProcess } from "./fixtures/standalone-runtime-process.js";

// Original empty preview1 command. No compiler, engine build or Worker is needed.
const module = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);

function childFixture() {
  const descriptors = new DescriptorTable();
  const root = createWorkerProcessTransport({ capacity: 3 });
  let child: WorkerProcessTransport | undefined;
  const parent = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: {
      export() {
        throw new Error("unexpected descriptor export");
      },
      import() {
        throw new Error("unexpected descriptor import");
      },
      discard() {},
    },
    postMessage(message) {
      if (message.operation === "spawn") child = message.transport;
    },
  });
  const spawn = () => {
    parent.spawn(parent.pid, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: parent.job,
      fds: [],
    });
    if (!child) throw new Error("missing child transport");
    return child;
  };
  return { descriptors, spawn, transport: standaloneRuntimeProcess(spawn()) };
}

async function observeDefaultSignal(
  transport: WorkerProcessTransport,
  beforeSignal: () => void = () => {},
  postMessage: import("../browser/worker.js").RuntimeWorkerHost["postMessage"] = () => {},
  options: { checkActiveOnly?: boolean; adapterSignal?: boolean; recheck?: boolean } = {},
) {
  const connection = createFilesystemConnection();
  const messages: import("../browser/worker.js").RuntimeWorkerMessage[] = [];
  let observed: unknown;
  let rechecked: unknown;
  try {
    await bootstrap(
      {
        controlGrant: { kind: "unbounded" },
        module,
        args: [],
        env: {},
        filesystem: connection.client,
        runtimeProcess: transport,
      },
      {
        setup({ fs }) {
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
        },
        run(context) {
          beforeSignal();
          try {
            if (options.checkActiveOnly) context.checkActive();
            else context.defaultSignal(15);
          } catch (error) {
            observed = error;
          }
          if (options.recheck) rechecked = captureError(context.checkActive);
          return 0;
        },
        signalError: options.adapterSignal
          ? (signal) => {
              throw new ProcessSignalExit(signal);
            }
          : undefined,
      },
      {
        crossOriginIsolated: true,
        postMessage(message) {
          messages.push(message);
          postMessage(message);
        },
      },
    ).catch((error: unknown) => {
      if (error !== observed) throw error;
    });
    return { observed, rechecked, messages, revoked: sharedRevoked(connection.client)() };
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
}

for (const boundary of ["entry", "tagged-load"] as const)
  for (const adapterSignal of [false, true])
    test(`selected signal survives collection at ${boundary}, adapter=${adapterSignal}`, async () => {
      const fixture = childFixture();
      const state = workerProcessState(fixture.transport);
      const originalLoad = TaggedCells.prototype.load;
      const originalCheck = OutcomeCell.prototype.check;
      let successor: ReturnType<typeof workerProcessState> | undefined;
      let successorBytes: Uint8Array | undefined;
      let snapshot: Uint8Array | undefined;
      let successorReads = 0;
      let recording = false;
      const collect = () => {
        const selected = readOutcome(state.signals.outcome);
        if (!selected) throw new Error("missing authenticated winner");
        expect(selected).toEqual({ kind: "signaled", code: 15, status: 143 });
        expect(Object.isFrozen(selected)).toBe(true);
        confirmDirectoryProcess(fixture.transport);
        expect(collectDirectoryProcess(fixture.transport)).toEqual(selected);
        successor = workerProcessState(fixture.spawn());
        expect(successor.slot).not.toBe(state.slot);
        expect(successor.pid).not.toBe(state.pid);
        const successorOutcome = successor.signals.outcome;
        if (!(successorOutcome instanceof OutcomeCell))
          throw new Error("expected tagged successor");
        const start = successorOutcome.validity.byteOffset;
        successorBytes = new Uint8Array(
          successorOutcome.validity.buffer,
          start,
          successor.terminalStopped.byteOffset + 8 - start,
        );
        snapshot = successorBytes.slice();
        recording = true;
      };
      let invalidated = false;
      let terminalChecks = 0;
      const loads = spyOn(TaggedCells.prototype, "load").mockImplementation(function (
        this: TaggedCells,
        index = 0,
      ) {
        if (recording && this.id === successor?.pid) successorReads++;
        if (
          !invalidated &&
          boundary === "tagged-load" &&
          this.id === state.pid &&
          this.byteOffset === state.signals.requestedSignal.byteOffset &&
          readOutcome(state.signals.outcome)?.kind === "signaled"
        ) {
          invalidated = true;
          collect();
        }
        return originalLoad.call(this, index);
      });
      const outcomes = spyOn(OutcomeCell.prototype, "check").mockImplementation(function (
        this: OutcomeCell,
      ) {
        if (recording && this.pid === successor?.pid) successorReads++;
        if (
          !invalidated &&
          boundary === "entry" &&
          this.pid === state.pid &&
          (Atomics.load(this.cells, 0) & 3n) === 2n &&
          ++terminalChecks === 2
        ) {
          invalidated = true;
          collect();
        }
        return originalCheck.call(this);
      });
      try {
        const { observed, rechecked, messages, revoked } = await observeDefaultSignal(
          fixture.transport,
          () => {},
          () => {},
          { adapterSignal, recheck: true },
        );
        recording = false;
        expect(invalidated).toBe(true);
        expect(successorReads).toBe(0);
        expect(successorBytes).toEqual(snapshot);
        expect(readOutcome(successor!.signals.outcome)).toBeNull();
        const signalType = adapterSignal ? ProcessSignalExit : RuntimeWorkerSignal;
        expect(observed).toBeInstanceOf(signalType);
        expect(observed).toMatchObject({ signal: 15 });
        expect(rechecked).toBeInstanceOf(signalType);
        expect(rechecked).toMatchObject({ signal: 15 });
        expect(messages.find((message) => message.type === "exit")).toMatchObject({
          code: 143,
          signal: 15,
        });
        expect(revoked).toBe(true);
      } finally {
        recording = false;
        outcomes.mockRestore();
        loads.mockRestore();
        fixture.descriptors.dispose();
      }
    });

test("checkActive rejects unauthorized row reuse while its active observation is retained", async () => {
  const fixture = childFixture();
  const state = workerProcessState(fixture.transport);
  let successor: ReturnType<typeof workerProcessState> | undefined;
  try {
    const result = await observeDefaultSignal(
      fixture.transport,
      () => {
        claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 });
        confirmDirectoryProcess(fixture.transport);
        collectDirectoryProcess(fixture.transport);
        const outcome = state.signals.outcome;
        if (!(outcome instanceof OutcomeCell)) throw new Error("expected captured outcome");
        Atomics.store(
          new BigInt64Array(outcome.validity.buffer, outcome.validity.byteOffset, 1),
          0,
          0n,
        );
        successor = workerProcessState(fixture.spawn());
      },
      () => {},
      { checkActiveOnly: true },
    );
    expect(result.observed).toBeInstanceOf(ProcessError);
    expect(result.observed).toMatchObject({ errno: 71 });
    expect(result.observed).not.toBeInstanceOf(RuntimeWorkerSignal);
    expect(successor?.slot).toBe(state.slot);
    expect(readOutcome(successor!.signals.outcome)).toBeNull();
  } finally {
    fixture.descriptors.dispose();
  }
});

test("normal default-signal bookkeeping delivers the selected typed signal", async () => {
  const fixture = childFixture();
  try {
    const result = await observeDefaultSignal(fixture.transport);
    expect(result.observed).toBeInstanceOf(RuntimeWorkerSignal);
    expect(result.revoked).toBe(true);
    expect(readOutcome(workerProcessState(fixture.transport).signals.outcome)).toEqual({
      kind: "signaled",
      code: 15,
      status: 143,
    });
  } finally {
    fixture.descriptors.dispose();
  }
});

test("a conflicting immutable exit never becomes a signal", async () => {
  const fixture = childFixture();
  const state = workerProcessState(fixture.transport);
  try {
    const result = await observeDefaultSignal(fixture.transport, () => {
      claimOutcome(state.signals.outcome, { kind: "exited", code: 23 });
    });
    expect(result.observed).toBeInstanceOf(WasiExit);
    expect(result.observed).toMatchObject({ code: 23 });
    expect(readOutcome(state.signals.outcome)).toEqual({ kind: "exited", code: 23, status: 23 });
  } finally {
    fixture.descriptors.dispose();
  }
});

test("invalid identity without an authenticated winner retains ProcessError", async () => {
  const fixture = childFixture();
  const state = workerProcessState(fixture.transport);
  const outcome = state.signals.outcome;
  if (!(outcome instanceof OutcomeCell)) throw new Error("expected tagged outcome");
  try {
    const result = await observeDefaultSignal(fixture.transport, () => {
      expect(readOutcome(outcome)).toBeNull();
      // No terminal winner exists, so real collection cannot run. Invalidate only this
      // captured lifecycle word to exercise rejection, without inventing an outcome.
      Atomics.store(
        new BigInt64Array(outcome.validity.buffer, outcome.validity.byteOffset, 1),
        0,
        0n,
      );
    });
    expect(result.observed).toBeInstanceOf(ProcessError);
    expect(result.observed).toMatchObject({ errno: 71 });
    expect(result.observed).not.toBeInstanceOf(RuntimeWorkerSignal);
  } finally {
    fixture.descriptors.dispose();
  }
});

test("an unrelated shared-read ProcessError on a valid identity is rethrown unchanged", async () => {
  const fixture = childFixture();
  const state = workerProcessState(fixture.transport);
  const unrelated = new ProcessError(71, "process incarnation was collected");
  const original = TaggedCells.prototype.load;
  let injected = false;
  const loads = spyOn(TaggedCells.prototype, "load").mockImplementation(function (
    this: TaggedCells,
    index = 0,
  ) {
    if (
      !injected &&
      this.id === state.pid &&
      this.byteOffset === state.signals.requestedSignal.byteOffset &&
      readOutcome(state.signals.outcome)
    ) {
      injected = true;
      throw unrelated;
    }
    return original.call(this, index);
  });
  try {
    const result = await observeDefaultSignal(fixture.transport);
    expect(injected).toBe(true);
    expect(result.observed).toBe(unrelated);
  } finally {
    loads.mockRestore();
    fixture.descriptors.dispose();
  }
});

for (const collected of [false, true])
  test(`unrelated ProcessError keeps exact identity with collected=${collected}`, async () => {
    const fixture = childFixture();
    const state = workerProcessState(fixture.transport);
    const unrelated = new ProcessError(71, "process incarnation was collected");
    let injected = false;
    try {
      const result = await observeDefaultSignal(
        fixture.transport,
        () => {},
        (message) => {
          if (injected || message.type !== "runtime-proc" || message.operation !== "exit") return;
          injected = true;
          expect(readOutcome(state.signals.outcome)).toEqual({
            kind: "signaled",
            code: 15,
            status: 143,
          });
          if (collected) {
            confirmDirectoryProcess(fixture.transport);
            collectDirectoryProcess(fixture.transport);
          }
          throw unrelated;
        },
      );
      expect(injected).toBe(true);
      expect(result.observed).toBe(unrelated);
    } finally {
      fixture.descriptors.dispose();
    }
  });
