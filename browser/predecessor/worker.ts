// One worker per `bun …` command: instantiate bun.wasm fresh, run it, send the filesystem back.
// The "browser" engine (bun-browser.wasm) runs natives and the transpiler in wasm, then hands the
// program to engine-host.js, which runs it in this worker's own JS engine.

import { startEngineHost } from "./engine-host.js";
import { type DirNode, MemFS } from "./fs";
import { NetHost } from "./net/host";
import type { NetRequest } from "./net/protocol";
import { installHostSlots } from "./net/trampoline";
import { Wasi, WasiExit, compactFs } from "./wasi";

export type Engine = "quickjs" | "jsc" | "browser";

export interface RunRequest {
  engine: Engine;
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
// The browser engine replaces globalThis.performance with the runtime's (which calls into wasm).
const perfNow = performance.now.bind(performance);

function sleep(ms: number): void {
  if (ms <= 0) return;
  if (sleepCell) {
    Atomics.wait(sleepCell, 0, 0, ms);
    return;
  }
  // Without cross-origin isolation there is no SharedArrayBuffer, so spin. This only burns the worker's thread.
  const end = perfNow() + ms;
  while (perfNow() < end) {
    /* spin */
  }
}

const sendNet = (req: NetRequest, transfer: Transferable[] = []) => ctx.postMessage({ type: "net", req } satisfies WorkerMessage, transfer);

/** Gives bun.wasm fetch and Bun.serve through the bun_wasm host slots (docs/host-abi.md). */
function installNet(instance: WebAssembly.Instance, sab: SharedArrayBuffer): void {
  const host = new NetHost(sab, sendNet);
  host.attach(instance.exports.memory as WebAssembly.Memory);
  installHostSlots(instance, host.slots());
}

ctx.onmessage = async (event: MessageEvent<RunRequest>) => {
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
  let done = false;
  /** Sends the result (once) with the filesystem; the page then terminates this worker. */
  const finish = (result: { code: number } | { error: unknown }) => {
    if (done) return;
    done = true;
    compactFs(fs.root);
    if ("code" in result) {
      ctx.postMessage({ type: "exit", code: result.code, root: fs.root, sleep: sleepMode } satisfies WorkerMessage);
      return;
    }
    const err = result.error;
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.postMessage({ type: "error", message, root: fs.root, sleep: sleepMode } satisfies WorkerMessage);
  };
  try {
    const instance = new WebAssembly.Instance(req.module, wasi.imports(req.module));
    if (req.net && req.engine !== "browser") installNet(instance, req.net);
    const exited = wasi.launch(instance);
    const ready = instance.exports.bunwasm_ready as (() => number) | undefined;
    if (exited !== null || req.engine !== "browser" || ready?.() !== 1) {
      finish({ code: exited ?? 0 });
      return;
    }
    // A wasm native calling proc_exit from a JS callback (a timer, a promise job) unwinds to here.
    const onError = (e: ErrorEvent) => {
      if (!(e.error instanceof WasiExit)) return;
      e.preventDefault();
      finish({ code: e.error.code });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (!(e.reason instanceof WasiExit)) return;
      e.preventDefault();
      finish({ code: e.reason.code });
    };
    ctx.addEventListener("error", onError);
    ctx.addEventListener("unhandledrejection", onRejection);
    // With a ring (cross-origin isolated page): the same NetHost as the wasm engines, so fetch goes
    // through the page's helper and Bun.serve gets /__preview/<port>/ connections.
    const net = req.net ? new NetHost(req.net, sendNet).engineNet() : undefined;
    const code = await startEngineHost({
      instance,
      moduleUrls: "blob",
      fetch: ctx.fetch.bind(ctx),
      net,
      onExit: (exitCode) => finish({ code: exitCode }),
    });
    finish({ code });
  } catch (err) {
    if (err instanceof WasiExit) finish({ code: err.code });
    else finish({ error: err });
  }
};
