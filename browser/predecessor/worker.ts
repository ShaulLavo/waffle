// One worker per `bun …` command: instantiate bun.wasm fresh, run it, send the filesystem back.

import { type DirNode, MemFS } from "./fs";
import { NetHost } from "./net/host";
import type { NetRequest } from "./net/protocol";
import { installHostSlots } from "./net/trampoline";
import { Wasi, compactFs } from "./wasi";

export interface RunRequest {
  module: WebAssembly.Module;
  args: string[];
  env: Record<string, string>;
  root: DirNode;
  trace: boolean;
  /** The networking ring (net/ring.ts); null when the page is not cross-origin isolated. */
  net: SharedArrayBuffer | null;
}

export type WorkerMessage =
  | { type: "stdout"; data: Uint8Array }
  | { type: "stderr"; data: Uint8Array }
  | { type: "net"; req: NetRequest }
  | { type: "exit"; code: number; root: DirNode; sleep: SleepMode }
  | { type: "error"; message: string; root: DirNode; sleep: SleepMode };

export type SleepMode = "atomics" | "busy-wait";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const sleepCell = ctx.crossOriginIsolated && typeof SharedArrayBuffer === "function" ? new Int32Array(new SharedArrayBuffer(4)) : null;
const sleepMode: SleepMode = sleepCell ? "atomics" : "busy-wait";

function sleep(ms: number): void {
  if (ms <= 0) return;
  if (sleepCell) {
    Atomics.wait(sleepCell, 0, 0, ms);
    return;
  }
  // Without cross-origin isolation there is no SharedArrayBuffer, so spin. This only burns the worker's thread.
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* spin */
  }
}

/** Gives bun.wasm fetch and Bun.serve through the bun_wasm host slots (docs/host-abi.md). */
function installNet(instance: WebAssembly.Instance, sab: SharedArrayBuffer): void {
  const host = new NetHost(sab, (req, transfer = []) => ctx.postMessage({ type: "net", req } satisfies WorkerMessage, transfer));
  host.attach(instance.exports.memory as WebAssembly.Memory);
  installHostSlots(instance, host.slots());
}

ctx.onmessage = (event: MessageEvent<RunRequest>) => {
  const req = event.data;
  const fs = new MemFS(req.root);
  const post = (type: "stdout" | "stderr", data: Uint8Array) => ctx.postMessage({ type, data }, [data.buffer]);
  const wasi = new Wasi({
    args: req.args,
    env: req.env,
    fs,
    preopens: { "/": "/" },
    stdout: (data) => post("stdout", data),
    stderr: (data) => post("stderr", data),
    sleep,
    trace: req.trace ? (line) => console.debug(`[wasi] ${line}`) : undefined,
  });
  let message: WorkerMessage;
  try {
    const instance = new WebAssembly.Instance(req.module, wasi.imports(req.module));
    if (req.net) installNet(instance, req.net);
    const code = wasi.start(instance);
    compactFs(fs.root);
    message = { type: "exit", code, root: fs.root, sleep: sleepMode };
  } catch (err) {
    compactFs(fs.root);
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    message = { type: "error", message: text, root: fs.root, sleep: sleepMode };
  }
  ctx.postMessage(message);
};
