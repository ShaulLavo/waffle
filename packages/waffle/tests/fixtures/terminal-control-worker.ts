import { parentPort, workerData } from "node:worker_threads";
import { pauseInputAcquisition } from "./terminal-input-pause.js";
import type { TerminalContext, TerminalTurn } from "../../browser/runtime-terminals.js";
import type { WorkerProcessTransport, WorkerProcessMessage } from "../../proc/worker-client.js";
import type { FilesystemIdentity } from "../../fs/protocol.js";

export interface TerminalControlWorkerData {
  role: "holder" | "parent" | "child";
  process: WorkerProcessTransport;
  context: TerminalContext;
  input: SharedArrayBuffer;
  flags: SharedArrayBuffer;
  count?: number;
  childFilesystem?: FilesystemIdentity;
  inputPause?: boolean;
  readOnlyPause?: boolean;
}
const data: TerminalControlWorkerData = workerData;
if (!parentPort) throw Error("missing host port");
const port = parentPort;
port.on("message", () => {});
const flags = new Int32Array(data.flags);
let paused = false;
function pause() {
  if (paused) return;
  paused = true;
  Atomics.store(flags, 0, 1);
  port.postMessage({ kind: "held", pid: data.process.pid });
  Atomics.wait(flags, 1, 0);
}
// Controlled test seam: preserve the real input CAS and pause only after it acquired.
if (data.inputPause) pauseInputAcquisition(data.input, pause);
const { attachTerminal, createTerminalInputPolicy } =
  await import("../../browser/runtime-terminals.js");
const { WorkerProcessClient } = await import("../../proc/worker-client.js");
const { DescriptorTable } = await import("../../core/descriptors.js");
const { ProcessABI } = await import("../../proc/abi.js");
const { MemFS } = await import("../../fs/memory.js");
const { createFilesystemIdentity } = await import("../../fs/protocol.js");
const descriptors = new DescriptorTable();
const postMessage = (message: WorkerProcessMessage) => port.postMessage(message);
const client = new WorkerProcessClient({
  transport: data.process,
  descriptors,
  codec: {
    export() {
      throw Error("unused export");
    },
    import() {
      throw Error("unused import");
    },
    discard() {},
  },
  postMessage,
  prepareSpawn: () => ({
    data: {
      filesystem: createFilesystemIdentity(data.childFilesystem),
      terminalContext: data.context,
      terminalInput: data.input,
    },
  }),
});
const base = createTerminalInputPolicy({ input: data.input });
function holderReadiness(turn: TerminalTurn) {
  if (data.readOnlyPause) {
    pause();
    return { readable: false, nbytes: 0 };
  }
  return data.inputPause ? { readable: true, nbytes: 1 } : base.inputReadiness(turn);
}
const attachment = attachTerminal({
  context: data.context,
  process: data.process,
  checkActive() {},
  policy:
    data.role === "holder"
      ? {
          ...base,
          inputReadiness: holderReadiness,
          tryRead(turn, chunks) {
            if (!data.inputPause) pause();
            return base.tryRead(turn, chunks);
          },
        }
      : base,
});
try {
  if (data.role !== "parent") {
    const ready = attachment.ready();
    if (ready.kind === "error") throw Error(ready.code);
  }
  if (data.role === "holder") {
    client.started();
    const stream = attachment.resolve(0);
    const count = data.readOnlyPause
      ? Number(stream.readiness().readable)
      : stream.tryRead!([new Uint8Array(1)]);
    port.postMessage({ kind: "released", pid: data.process.pid, count });
  } else if (data.role === "parent") {
    // The readiness attempt may contend; it returns before spawn and blocking wait_job.
    attachment.resolve(0).tryRead!([new Uint8Array(1)]);
    let job = -1;
    const children: number[] = [];
    for (let index = 0; index < (data.count ?? 1); index++) {
      const pid = client.spawn(client.pid, {
        executable: "fixture",
        argv: ["child"],
        env: {},
        cwd: "/",
        job,
        fds: [],
      });
      children.push(pid);
      job = client.jobOf(pid);
    }
    Atomics.store(flags, 2, 1);
    port.postMessage({ kind: "waiting", children, job });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({
      memory,
      descriptors,
      fs: new MemFS(),
      pid: client.pid,
      service: client,
      signals: client.signals,
      wake: client.wake,
    });
    const code = abi.imports.wait_job!(job, 0, 64);
    const status = new DataView(memory.buffer).getInt32(68, true);
    Atomics.store(flags, 3, 1);
    port.postMessage({ kind: "parent-done", children, code, status });
  } else {
    const started = client.started();
    port.postMessage({ kind: "child-entry", pid: client.pid, started });
    attachment.dispose();
    descriptors.dispose();
    client.exit(7);
  }
} catch (cause) {
  port.postMessage({ kind: "failure", pid: client.pid, error: String(cause) });
  throw cause;
}
