import {
  observationModule,
  awaitObservationBarrier,
} from "./fixtures/process-observation-controls.ts";
import { expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.ts";
import type { RuntimeWorkerRequest } from "../browser/worker.ts";
import { DescriptorTable } from "../core/descriptors.ts";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
} from "../fs/protocol.ts";
import { ProcessIdentityAllocator } from "../proc/identity.ts";
import { ExecutableRegistry } from "../proc/registry.ts";
import { ProcessTable } from "../proc/table.ts";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.ts";
import { OutcomeCell, readOutcome } from "../proc/outcome.ts";
import { testReservations } from "../tests/fixtures/shared-memory-platform.ts";

async function settleDisposal(disposal: Promise<void>, expectedFailure: boolean): Promise<void> {
  try {
    await disposal;
  } catch (error) {
    if (!expectedFailure) throw error;
  }
}

for (const mode of [
  "kill-retained",
  "kill-wait",
  "dispose-orphan",
  "void-return",
  "promise-return",
  "throw-stop",
  "reject-stop",
  "initial-selected",
  "initial-terminated",
  "runtime-selected",
  "runtime-terminated",
] as const) {
  test(`observation survives logical collection before native return: ${mode}`, async () => {
    const previousWorker = globalThis.Worker;
    const workers: Worker[] = [];
    const ports: MessagePort[] = [];
    const stop = Promise.withResolvers<void>();
    const gate = new Int32Array(new SharedArrayBuffer(12));
    const errors: unknown[] = [];
    let stopEntered = false;
    let stopCalls = 0;
    let nativeReturned = false;
    let observed: unknown;
    let workerFinished = false;
    let bootstrapFinished = false;
    let tearingDown = false;
    const expired =
      mode === "void-return" ||
      mode === "promise-return" ||
      mode === "initial-terminated" ||
      mode === "runtime-terminated";
    const acquisition = mode.startsWith("initial-") || mode.startsWith("runtime-");
    const stopFailure = mode === "throw-stop" || mode === "reject-stop";
    const failure = new Error("test native stop failed");
    class DelayedStopWorker extends previousWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this);
        this.addEventListener("message", (event) => {
          if (event.data.observed) observed = event.data.observed;
          if (event.data.ownedCleanupFinished) bootstrapFinished = true;
          if (event.data.type === "error" || event.data.type === "exit") workerFinished = true;
        });
      }
      override terminate(): void | Promise<void> {
        if (tearingDown) return super.terminate();
        stopCalls++;
        stopEntered = true;
        if (mode === "throw-stop") throw failure;
        if (mode === "reject-stop") return Promise.reject(failure);
        if (expired && mode !== "promise-return") {
          nativeReturned = true;
          return;
        }
        return stop.promise.then(async () => {
          if (mode !== "promise-return") await super.terminate();
          nativeReturned = true;
        });
      }
    }
    const identities = new ProcessIdentityAllocator();
    const table = new ProcessTable(identities);
    const registry = new ExecutableRegistry();
    registry.register("fixture", {
      module: observationModule,
      adapter: "fixture",
      interruptible: true,
    });
    const broker = new BrowserProcessBroker({
      reservations: testReservations(),
      identities,
      table,
      registry,
      onError(error) {
        errors.push(String(error));
      },
      filesystem: {
        connect(identity) {
          const connection = connectFilesystemIdentity(identity);
          ports.push(connection.client.port, connection.server.port);
          return connection.client;
        },
        revoke: revokeFilesystem,
        reap: reapFilesystem,
        quiesce: waitForFilesystemQuiescence,
      },
      launch(context) {
        return broker.launchWorker<
          RuntimeWorkerRequest & { gate: SharedArrayBuffer; boundary: "initial" | "runtime" }
        >(context, {
          workerUrl: acquisition
            ? new URL("./fixtures/process-observation-acquisition-worker.ts", import.meta.url).href
            : new URL("./fixtures/process-observation-worker.ts", import.meta.url).href,
          request: {
            module: observationModule,
            args: [],
            env: {},
            gate: gate.buffer,
            boundary: mode.startsWith("initial-") ? "initial" : "runtime",
          },
        });
      },
    });
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
      capacity: 3,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    const descriptors = new DescriptorTable();
    const messages: WorkerProcessMessage[] = [];
    const parent = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: {
        export() {
          throw new Error("no descriptor export");
        },
        import() {
          throw new Error("no descriptor import");
        },
        discard() {},
      },
      postMessage(message) {
        messages.push(message);
      },
      prepareSpawn() {
        return { data: { filesystem: createFilesystemIdentity() } };
      },
    });
    const release = (index: number) => {
      Atomics.store(gate, index, 1);
      Atomics.notify(gate, index);
    };
    let disposal: Promise<void> | undefined;
    try {
      globalThis.Worker = DelayedStopWorker;
      await broker.adoptRuntimeRoot(root, { memory: [] });
      const pid = parent.spawn(parent.pid, {
        executable: "fixture",
        argv: [],
        env: {},
        cwd: "/",
        job: -1,
        fds: [],
      });
      for (const message of messages) await broker.runtimeMessage(message, parent.pid);
      const supervisor = await broker.ready();
      await supervisor.start(pid);
      const transport = broker.transportFor(pid);
      if (!transport) throw new Error("missing admitted transport");
      const state = workerProcessState(transport);
      const outcome = state.signals.outcome;
      if (!(outcome instanceof OutcomeCell)) throw new Error("expected captured incarnation");
      await awaitObservationBarrier(() => Atomics.load(gate, 0) === 1);
      expect(readOutcome(state.signals.outcome)).toBeNull();
      if (mode !== "dispose-orphan") await broker.kill(pid, 9);
      else disposal = broker.dispose();
      expect(stopEntered).toBe(false);
      expect(Atomics.load(gate, 0)).toBe(1);
      expect(state.confirmed.load()).toBe(0);
      expect(outcome.valid()).toBe(true);
      if (mode !== "dispose-orphan") expect(parent.wait(parent.pid, pid)).toBeNull();
      release(1);
      await awaitObservationBarrier(() => Atomics.load(gate, 0) === 2 && stopEntered);
      if (mode === "promise-return") {
        expect(nativeReturned).toBe(false);
        stop.resolve();
        await awaitObservationBarrier(() => nativeReturned);
      }
      expect(nativeReturned).toBe(expired);
      let result: unknown;
      if (mode !== "kill-retained" && mode !== "dispose-orphan")
        result = parent.wait(parent.pid, pid);
      expect(outcome.valid()).toBe(mode === "kill-retained");
      let successorSnapshot: Uint8Array | undefined;
      let successorBytes: Uint8Array | undefined;
      let successor: ReturnType<typeof workerProcessState> | undefined;
      if (mode === "kill-wait" || expired || acquisition) {
        const nextPid = parent.spawn(parent.pid, {
          executable: "fixture",
          argv: [],
          env: {},
          cwd: "/",
          job: parent.job,
          fds: [],
        });
        const next = messages.find(
          (message) => message.operation === "spawn" && message.transport.pid === nextPid,
        );
        if (!next || next.operation !== "spawn") throw new Error("missing successor");
        successor = workerProcessState(next.transport);
        if (expired) expect(successor.slot).toBe(state.slot);
        else expect(successor.slot).not.toBe(state.slot);
        expect(successor.pid).not.toBe(pid);
        const nextOutcome = successor.signals.outcome;
        if (!(nextOutcome instanceof OutcomeCell))
          throw new Error("expected successor incarnation");
        successorBytes = new Uint8Array(
          nextOutcome.validity.buffer,
          nextOutcome.validity.byteOffset,
          successor.terminalStopped.byteOffset + 8 - nextOutcome.validity.byteOffset,
        );
        successorSnapshot = successorBytes.slice();
      }
      expect(Atomics.load(gate, 0)).toBe(2);
      release(2);
      await awaitObservationBarrier(() => observed !== undefined && bootstrapFinished);
      expect(workerFinished).toBe(!expired);
      if (mode === "kill-retained") {
        expect(observed).toMatchObject({ authenticatedSignal: 9 });
        result = parent.wait(parent.pid, pid);
      } else if (expired)
        expect(observed).toMatchObject({ terminated: true, authenticatedSignal: null });
      else expect(observed).toMatchObject({ authenticatedSignal: 9 });
      if (successor) {
        expect(successorBytes).toEqual(successorSnapshot);
        expect(readOutcome(successor.signals.outcome)).toBeNull();
      }
      expect(Atomics.load(gate, 0)).toBe(4);
      expect(nativeReturned).toBe(expired);
      expect(stopCalls).toBe(1);
      if (mode !== "dispose-orphan")
        expect(result).toEqual({ kind: "signaled", code: 9, status: 137 });
    } finally {
      release(1);
      release(2);
      stop.resolve();
      try {
        await settleDisposal(disposal ?? broker.dispose(), stopFailure);
      } finally {
        tearingDown = true;
        await Promise.all(
          workers.map((worker) => Reflect.apply(previousWorker.prototype.terminate, worker, [])),
        );
        for (const port of ports) port.close();
        descriptors.dispose();
        globalThis.Worker = previousWorker;
      }
    }
  }, 15000);
}
