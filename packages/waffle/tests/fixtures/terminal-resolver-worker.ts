import { parentPort, workerData } from "node:worker_threads";
import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";
import {
  attachTerminal,
  createTerminalInputPolicy,
  type TerminalAttachment,
} from "../../browser/runtime-terminals.js";
import type { Stream } from "../../core/descriptors.js";
import type { WorkerProcessTransport } from "../../proc/worker-client.js";

export interface TerminalResolverRequest extends RuntimeWorkerRequest {
  runtimeProcess: WorkerProcessTransport;
}
export interface TerminalResolverResult {
  type: "resolver-result";
  input: string;
  stdout: boolean;
  stderr: boolean;
  policyWrite: number | undefined;
  revoked: boolean;
}

const request: TerminalResolverRequest = workerData;
let terminal: TerminalAttachment | undefined;
let output: Stream | undefined;
let result: Omit<TerminalResolverResult, "type" | "revoked"> | undefined;
let policyWrite: number | undefined;
try {
  await bootstrap(
    request,
    {
      setup(context) {
        context.fs.preopen = () => 1;
        context.fs.retain = () => {};
        context.fs.release = () => {};
        const data = request.runtimeProcess.data;
        if (typeof data !== "object" || data === null || !("terminalContext" in data)) return;
        if (!("terminalInput" in data) || !(data.terminalInput instanceof SharedArrayBuffer))
          throw Error("missing terminal input");
        const policy = createTerminalInputPolicy({ input: data.terminalInput });
        policyWrite = policy.tryWrite(1, [new Uint8Array([65])]);
        terminal = attachTerminal({
          context: data.terminalContext,
          process: request.runtimeProcess,
          checkActive: context.checkActive,
          policy,
        });
        const ready = terminal.ready();
        if (ready.kind === "error") throw Error(ready.code);
      },
      resolveTerminal: (target) => (target === 0 ? terminal?.resolve(0) : undefined),
      beforeFinish() {
        terminal?.dispose();
      },
      run({ wasi, post }) {
        const stdin = wasi.descriptors.get(0)?.resource;
        const stdout = wasi.descriptors.get(1)?.resource;
        if (!stdin || stdin.kind === "directory" || stdin.kind === "file")
          throw Error("missing stream stdin");
        if (!stdout || stdout.kind === "directory" || stdout.kind === "file")
          throw Error("missing stream stdout");
        output = stdout;
        const bytes = new Uint8Array(16);
        const count = stdin.tryRead?.([bytes]);
        if (count === undefined || count < 0) throw Error(`unexpected stdin read ${count}`);
        result = {
          input: new TextDecoder().decode(bytes.subarray(0, count)),
          stdout: post("stdout", new TextEncoder().encode("out")),
          stderr: post("stderr", new TextEncoder().encode("err")),
          policyWrite,
        };
        return 0;
      },
    },
    { crossOriginIsolated: true, postMessage: (message) => parentPort!.postMessage(message) },
  );
  if (!result || !output) throw Error("worker did not execute");
  let revoked = false;
  try {
    output.tryWrite?.([new Uint8Array([65])]);
  } catch {
    revoked = true;
  }
  parentPort!.postMessage({
    type: "resolver-result",
    ...result,
    revoked,
  } satisfies TerminalResolverResult);
} finally {
  terminal?.dispose();
  parentPort!.close();
}
