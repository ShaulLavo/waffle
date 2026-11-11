import {
  observationModule,
  awaitObservationBarrier,
} from "./fixtures/process-observation-controls.ts";
import { expect, test } from "bun:test";
import { ProcessSupervisor } from "../proc/supervisor.ts";
import { ExecutableRegistry } from "../proc/registry.ts";
import { ProcessIdentityAllocator } from "../proc/identity.ts";
import { ProcessTable } from "../proc/table.ts";
import { BrowserProcessBroker } from "../browser/process-broker.ts";
import { outcomeWord, claimOutcome, readOutcome, serializeOutcome } from "../proc/outcome.ts";
import { captureProcessObserver } from "../proc/observation.ts";
import {
  createFilesystemIdentity,
  connectFilesystemIdentity,
  revokeFilesystem,
  waitForFilesystemQuiescence,
} from "../fs/protocol.ts";
import { testReservations } from "./fixtures/shared-memory-platform.ts";

for (const mode of ["held", "void", "promise", "rejected"] as const) {
  test(`direct-supervisor standalone native return uses its original canonical word: ${mode}`, async () => {
    const registry = new ExecutableRegistry();
    registry.register("fixture", {
      module: observationModule,
      adapter: "fixture",
      interruptible: true,
    });
    const identity = createFilesystemIdentity();
    const connection = connectFilesystemIdentity(identity);
    const gate = new Int32Array(new SharedArrayBuffer(12));
    const native = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    let worker: Worker | undefined;
    let observed: unknown;
    let finished = false;
    let nativeCalls = 0;
    let completions = 0;
    const supervisor = new ProcessSupervisor({
      registry,
      onError: (error) => errors.push(error),
      quiesce: () => waitForFilesystemQuiescence(identity),
      launch(context) {
        context.registerRevocation(() => revokeFilesystem(identity));
        worker = new Worker(new URL("./fixtures/process-observation-worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = ({ data }) => {
          if (data.observed) observed = data.observed;
          if (data.type === "error") errors.push(data.message);
          if (data.ownedCleanupFinished) finished = true;
          if (data.type === "exit") {
            completions++;
            context.exit(data.code);
          }
        };
        worker.postMessage(
          {
            module: observationModule,
            args: [],
            env: {},
            filesystem: connection.client,
            controlGrant: { kind: "unbounded" },
            gate: gate.buffer,
            outcome: serializeOutcome(context.outcome),
            observation: context.observation,
          },
          [connection.client.port],
        );
        return {
          terminate() {
            nativeCalls++;
            if (mode === "void") return;
            if (mode === "rejected") return Promise.reject(new Error("native stop rejected"));
            return native.promise;
          },
        };
      },
    });
    const root = supervisor.createRoot();
    const canonical = outcomeWord();
    const pid = supervisor.reserveSpawn(
      root,
      { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] },
      { outcome: canonical },
    );
    const record = supervisor.get(pid)!;
    const observer = captureProcessObserver(structuredClone(record.observation));
    const release = (index: number) => {
      Atomics.store(gate, index, 1);
      Atomics.notify(gate, index);
    };
    try {
      await supervisor.start(pid);
      expect(record.outcome).toBe(canonical);
      expect(record.observation.kind).toBe("standalone");
      await awaitObservationBarrier(() => Atomics.load(gate, 0) === 1 || errors.length > 0);
      expect(errors).toEqual([]);
      supervisor.kill(pid, 9);
      expect(supervisor.wait(root, pid)).toBeNull();
      release(1);
      await awaitObservationBarrier(() => nativeCalls === 1);
      expect(supervisor.wait(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
      if (mode === "promise") {
        expect(observer.read().kind).toBe("selected");
        native.resolve();
        await record.stopping?.complete;
      }
      const expired = mode === "void" || mode === "promise";
      expect(observer.read().kind).toBe(expired ? "terminated" : "selected");
      release(2);
      await awaitObservationBarrier(() => finished);
      expect(observed).toMatchObject(
        expired ? { terminated: true, authenticatedSignal: null } : { authenticatedSignal: 9 },
      );
      expect(completions).toBe(expired ? 0 : 1);
      expect(readOutcome(canonical)).toEqual({ kind: "signaled", code: 9, status: 137 });
      expect(claimOutcome(canonical, { kind: "exited", code: 137 })).toEqual({
        kind: "signaled",
        code: 9,
        status: 137,
      });
    } finally {
      release(1);
      release(2);
      native.resolve();
      await record.stopping?.complete.catch(() => {});
      supervisor.dispose();
      await worker?.terminate();
      connection.client.port.close();
      connection.server.port.close();
    }
    expect(nativeCalls).toBe(1);
  }, 15000);
}

for (const activation of ["lazy", "activated"] as const) {
  test(`standalone external root preserves aliases and its one token through ${activation} adoption`, async () => {
    const identities = new ProcessIdentityAllocator();
    const table = new ProcessTable(identities);
    const canonical = outcomeWord();
    const native = Promise.withResolvers<void>();
    let calls = 0;
    const broker = new BrowserProcessBroker({
      reservations: testReservations(),
      identities,
      table,
      registry: new ExecutableRegistry(),
      filesystem: {
        connect() {
          throw new Error("unused");
        },
        revoke() {},
        reap() {},
        async quiesce() {},
      },
      launch() {
        throw new Error("unused");
      },
      onError() {},
    });
    const pid = broker.reserveRoot(
      { outcome: canonical },
      {
        stop() {
          calls++;
          return native.promise;
        },
      },
    );
    const transfer = broker.rootObservation(pid);
    const observer = captureProcessObserver(transfer);
    try {
      expect(transfer.kind).toBe("standalone");
      if (activation === "activated") {
        const supervisor = await broker.ready();
        expect(supervisor.get(pid)!.observation).toBe(transfer);
        expect(supervisor.get(pid)!.outcome).toBe(canonical);
      }
      await broker.rootExit(pid, 137);
      expect(observer.read()).toEqual({
        kind: "selected",
        result: { kind: "exited", code: 137, status: 137 },
      });
      const disposing = broker.dispose();
      await awaitObservationBarrier(() => calls === 1);
      expect(observer.read().kind).toBe("selected");
      native.resolve();
      await disposing;
      expect(observer.read()).toEqual({ kind: "terminated" });
      expect(readOutcome(canonical)).toEqual({ kind: "exited", code: 137, status: 137 });
      expect(calls).toBe(1);
    } finally {
      native.resolve();
      await broker.dispose();
    }
  });
}

test("thread bootstrap rejects a producer word that differs from its standalone observation", async () => {
  const { admitProcessObservation } = await import("../proc/observation.ts");
  const { bootstrapGuestWorker } = await import("../thread/guest-worker.ts");
  const canonical = outcomeWord();
  const observation = admitProcessObservation(1, canonical);
  const channel = new MessageChannel();
  const reports: unknown[] = [];
  try {
    await expect(
      bootstrapGuestWorker(
        {
          module: observationModule,
          memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
          thread: { directory: "test", pid: 1, tid: 1 },
          entry: { kind: "initial" },
          args: [],
          env: {},
          observation,
          outcome: serializeOutcome(outcomeWord()),
          signal: new SharedArrayBuffer(4),
          waits: new SharedArrayBuffer(12),
          lane: { port: channel.port1, reply: new SharedArrayBuffer(16) },
        },
        {
          postMessage: (event) => reports.push(event),
          addEventListener() {},
          removeEventListener() {},
        },
      ),
    ).rejects.toThrow("Process observation differs from its canonical outcome");
    expect(reports).toEqual([]);
    expect(readOutcome(canonical)).toBeNull();
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
});
