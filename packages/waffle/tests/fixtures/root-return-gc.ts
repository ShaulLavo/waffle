import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { BrowserProcessBroker } from "../../browser/process-broker.ts";
import { ProcessIdentityAllocator } from "../../proc/identity.ts";
import { ProcessTable } from "../../proc/table.ts";
import { ExecutableRegistry } from "../../proc/registry.ts";
import { createWorkerProcessTransport } from "../../proc/worker-client.ts";
import { captureNativeReturn, captureProcessObserver } from "../../proc/observation.ts";
import { createFilesystemIdentity } from "../../fs/protocol.ts";
import { testReservations } from "./shared-memory-platform.ts";

function fixture() {
  const identities = new ProcessIdentityAllocator();
  const reservations = testReservations();
  const broker = new BrowserProcessBroker({
    reservations,
    identities,
    table: new ProcessTable(identities),
    registry: new ExecutableRegistry(),
    filesystem: {
      connect() {
        throw new Error("No filesystem connection is needed");
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch() {
      throw new Error("No child is launched");
    },
    onError(error) {
      throw error;
    },
  });
  return { identities, reservations, broker, workers: new Set<Worker>(), calls: 0 };
}

function captureHelper(broker: BrowserProcessBroker, pid: number) {
  return broker.captureRootStop(pid, () => {});
}

async function returnRoot(f: ReturnType<typeof fixture>, nativeFirst: boolean, helper: boolean) {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    parentPort.postMessage("ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `,
    { eval: true },
  );
  f.workers.add(worker);
  await once(worker, "message");
  const terminal = { worker };
  const env = { GC_PROBE: "original environment" };
  const signal = new AbortController().signal;
  const options = { terminal, env, signal };
  const references = {
    options: new WeakRef(options),
    terminal: new WeakRef(terminal),
    env: new WeakRef(env),
    signal: new WeakRef(signal),
  };
  const transport = createWorkerProcessTransport({ identity: f.identities.buffer });
  transport.data = { filesystem: createFilesystemIdentity() };
  await f.broker.adoptRuntimeRoot(transport, {
    memory: [],
    stop() {
      f.calls++;
      assert.equal(options.env.GC_PROBE, "original environment");
      assert.equal(options.signal.aborted, false);
      return options.terminal.worker.terminate().then(() => {});
    },
  });
  const stopHelper = helper ? captureHelper(f.broker, transport.pid) : undefined;
  const observer = captureProcessObserver(transport);
  const returned = captureNativeReturn(transport);
  if (!nativeFirst) await f.broker.rootExit(transport.pid, 0);
  await worker.terminate();
  f.workers.delete(worker);
  // Match the consumer that already publishes canonical termination independently.
  if (!helper) returned();
  f.broker.rootStopped(transport.pid);
  if (nativeFirst) await f.broker.rootExit(transport.pid, 0);
  assert.equal(observer.read().kind, helper ? "selected" : "terminated");
  assert.equal(f.broker.transportFor(transport.pid), undefined);
  return { references, observer, stopHelper };
}

async function collect(references: Record<string, WeakRef<object>>) {
  const gc = globalThis.gc;
  assert.ok(gc, "The control must run with --expose-gc");
  for (let pass = 0; pass < 8; pass++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
  }
  for (const [name, reference] of Object.entries(references))
    assert.equal(reference.deref() === undefined, true, `${name} retained after root disposal`);
}

for (const nativeFirst of [false, true]) {
  for (const helper of [false, true]) {
    test(`a live SDK owner releases root controller captures in eight GC turns, native first=${nativeFirst}, helper=${helper}`, async () => {
      const f = fixture();
      try {
        const { references, observer, stopHelper } = await returnRoot(f, nativeFirst, helper);
        await collect(references);
        assert.equal(observer.read().kind, helper ? "selected" : "terminated");
        stopHelper?.();
        assert.deepEqual(observer.read(), { kind: "terminated" });
        await f.broker.dispose();
        assert.equal(f.calls, 0, "acknowledgement must not invoke physical stop again");
      } finally {
        await Promise.all(Array.from(f.workers, (worker) => worker.terminate()));
        await f.broker.dispose();
        f.reservations.dispose();
      }
    });
  }
}
