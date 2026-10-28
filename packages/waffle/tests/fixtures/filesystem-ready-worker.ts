import { parentPort, workerData } from "node:worker_threads";
import { bootstrap, type WorkerExecutor } from "../../browser/worker.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import type { WorkerProcessTransport } from "../../proc/worker-client.js";

export interface FilesystemReadyWorkerData {
  connection: FilesystemConnection;
  flags: SharedArrayBuffer;
  stage: "setup" | "namespaces" | "preopens";
  process?: WorkerProcessTransport;
}
const data: FilesystemReadyWorkerData = workerData;
if (!parentPort) throw Error("missing host port");
const port = parentPort;
const flags = new Int32Array(data.flags);
const turn = new MessageChannel();
turn.port1.onmessage = () => port.postMessage({ type: "connect" });
turn.port2.postMessage(null);
const module = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);
const executor: WorkerExecutor = {
  setup({ fs }) {
    if (Atomics.load(flags, 0) !== 1)
      throw Error("executor hook ran before the first acknowledged filesystem request");
    if (data.stage === "setup") fs.preopen("/");
  },
  namespaces({ fs }) {
    if (data.stage === "namespaces") fs.preopen("/");
    return {};
  },
  diagnostic() {},
  run: (_context, exited) => exited ?? 0,
};
try {
  await bootstrap(
    {
      module,
      args: [],
      env: {},
      filesystem: data.connection,
      runtimeProcess: data.process,
    },
    executor,
    {
      crossOriginIsolated: true,
      postMessage: (message) => port.postMessage(message),
    },
  );
} finally {
  turn.port1.close();
  turn.port2.close();
}
