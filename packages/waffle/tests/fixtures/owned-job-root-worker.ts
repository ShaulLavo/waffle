import { parentPort, workerData } from "node:worker_threads";
import { DescriptorTable } from "../../core/descriptors.js";
import { MemFS } from "../../fs/memory.js";
import { createFilesystemIdentity } from "../../fs/protocol.js";
import { ProcessABI, ProcessSignalExit } from "../../proc/abi.js";
import { WorkerProcessClient, type WorkerProcessTransport } from "../../proc/worker-client.js";
import { controlLoad } from "../../proc/control.js";
import { SIGNAL_PENDING } from "../../proc/signals.js";

// A shell-shaped runtime root: it handles TERM, opts one background job into
// caller-fatal cleanup, leaves a sibling detached, then makes one CLEANUP wait.
const data: { transport: WorkerProcessTransport; gate: Int32Array; fatal: boolean } = workerData;
const descriptors = new DescriptorTable();
const client = new WorkerProcessClient({
  transport: data.transport,
  descriptors,
  codec: {
    export(): never {
      throw new Error("unexpected descriptor");
    },
    import(): never {
      throw new Error("unexpected descriptor");
    },
    discard() {},
  },
  postMessage: (message) => parentPort!.postMessage(message),
  prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
});
const memory = new WebAssembly.Memory({ initial: 1 });
const abi = new ProcessABI({
  memory,
  descriptors,
  fs: new MemFS(),
  service: client,
  pid: client.pid,
  signals: client.signals,
  wake: client.wake,
});
function spawn(owned: boolean): number {
  const request = JSON.stringify({
    executable: "fixture",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
    ...(owned ? { jobLifetime: "caller-fatal" } : {}),
  });
  const bytes = new TextEncoder().encode(request);
  new Uint8Array(memory.buffer).set(bytes, 1024);
  const pid = abi.imports.spawn!(1024, bytes.length);
  if (pid <= 0) throw new Error(`spawn failed: ${pid}`);
  return pid;
}
try {
  if (abi.imports.signal!(15, 2) !== 0) throw new Error("TERM handler rejected");
  const owned = spawn(true);
  const job = abi.imports.job_of!(owned);
  const detached = spawn(false);
  parentPort!.postMessage({ kind: "spawned", owned, job, detached });
  Atomics.wait(data.gate, 0, 0);
  if (!data.fatal && abi.imports.kill_job!(job, 9) !== 0) throw new Error("kill_job failed");
  parentPort!.postMessage({ kind: "waiting" });
  const result = abi.imports.wait_job!(job, 2, 0);
  const pending = controlLoad(client.signals.signalState, 15) & SIGNAL_PENDING;
  const first = abi.imports.interrupted!();
  const second = abi.imports.interrupted!();
  parentPort!.postMessage({
    kind: "complete",
    result,
    pending,
    first,
    second,
    outcome: Array.from(new Int32Array(memory.buffer, 0, 2)),
  });
  client.exit(0);
} catch (error) {
  if (!(error instanceof ProcessSignalExit)) throw error;
  parentPort!.postMessage({ kind: "fatal", signal: error.signal });
} finally {
  descriptors.dispose();
  parentPort!.close();
}
