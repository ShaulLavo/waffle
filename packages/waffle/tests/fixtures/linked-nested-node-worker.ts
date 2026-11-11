import { parentPort } from "node:worker_threads";
import { bootstrap, type WorkerExecutionContext } from "../../browser/worker.js";
import { linkedWorkerHooks, type LinkedWorkerRequest } from "../../link/index.js";
import { nodeWorkerTransfers } from "./node-worker-transfers.js";

async function run(context: WorkerExecutionContext<LinkedWorkerRequest>) {
  if (context.request.args[0] === "nested") return 0;
  const process = context.process;
  const memory = context.request.memoryGroup?.memory;
  if (!process || !memory) throw new Error("nested fixture needs an admitted group process");
  const request = new TextEncoder().encode(
    JSON.stringify({
      executable: "fixture",
      argv: ["nested"],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
      worker: { resourceLimits: { stackSizeMb: 4 } },
    }),
  );
  const pointer = memory.buffer.byteLength - 4096;
  new Uint8Array(memory.buffer, pointer, request.length).set(request);
  const pid = process.imports.spawn!(pointer, request.length);
  if (pid <= 0) throw new Error(`nested spawn failed ${pid}`);
  const deadline = Date.now() + 5000;
  let result = process.imports.wait!(pid, pointer);
  while (result === -6 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    result = process.imports.wait!(pid, pointer);
  }
  if (result !== 0) throw new Error(`nested wait failed ${result}`);
  return new DataView(memory.buffer).getInt32(pointer + 4, true);
}

parentPort!.on("message", (request: LinkedWorkerRequest) => {
  void bootstrap(
    request,
    {
      ...linkedWorkerHooks(),
      namespaces: () => ({ test: { check() {} } }),
      run,
    },
    {
      crossOriginIsolated: true,
      postMessage: (message, transfer) =>
        parentPort!.postMessage(message, nodeWorkerTransfers(transfer)),
    },
  );
});
