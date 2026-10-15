// One worker per `bun …` command: instantiate bun.wasm fresh, run it, send the filesystem back.
// The "browser" engine (bun-browser.wasm) runs natives and the transpiler in wasm, then hands the
// program to engine-host.js, which runs it in this worker's own JS engine.

import { startEngineHost } from "./engine-host.js";
import { type DirNode, MemFS } from "./fs";
import { NetHost } from "./net/host";
import type { NetRequest } from "./net/protocol";
import { installHostSlots, installHostSlotsViaImport } from "./net/trampoline";
import { Wasi, WasiExit, compactFs } from "./wasi";
import { SubprocessHost, childTransport, type ChildTransport } from "./subprocess.js";
import { filesystemChanges, mergeFilesystemChanges } from "./subprocess-fs";

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
  /**
   * Browser engine: the Cache Storage cache for this run's ES modules, which the service worker
   * serves under ./m/ (this worker runs from its ./__bunwasm/ scope). Null: blob URLs, no cycles.
   */
  moduleCache: string | null;
  /**
   * How the wasm engines get the networking host functions (`?slots=`): "imports" (default) has
   * the guest call them through a WASI import; "table" appends them to the guest's function table
   * as functions of a second module, which iOS Safari rejects at call_indirect ("signature does not
   * match"), so it is kept only for comparison; "off" installs none.
   */
  slots?: "table" | "imports" | "off";
  child?: ChildTransport;
  /** The page creates child workers while this worker may be blocked in a wasm call. */
  spawnBroker?: boolean;
}

// The browser engine's polyfills replace globalThis.Response; Cache.put needs the real one.
const NativeResponse = Response;

/** Named module URLs for engine-host.js, stored where the service worker (sw.ts) serves them. */
function moduleStore(cacheName: string) {
  const run = cacheName.replace(/^bunwasm-m-/, "");
  const base = new URL(`./m/${run}/`, self.location.href).href;
  const cache = caches.open(cacheName);
  return {
    url: (key: string) => base + encodeURIComponent(key),
    put: async (url: string, source: string) => {
      const headers = { "content-type": "text/javascript; charset=utf-8" };
      await (await cache).put(url, new NativeResponse(source, { headers }));
    },
  };
}

export type WorkerMessage =
  | { type: "spawn"; request: RunRequest }
  | { type: "phase"; name: string; duration: number }
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

/** `Name: message` plus the first stack frames (wasm function names when the build keeps them). */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const head = `${err.name}: ${err.message}`;
  const frames = (err.stack ?? "").split("\n").filter((line) => line.trim() && !line.includes(err.message)).slice(0, 15);
  return frames.length ? `${head}\n${frames.map((f) => `    ${f.trim()}`).join("\n")}` : head;
}

ctx.onmessage = async (event: MessageEvent<RunRequest>) => {
  ctx.postMessage({ type: "phase", name: "worker-start", duration: 0 } satisfies WorkerMessage);
  const req = event.data;
  const fs = new MemFS(req.root);
  const initialRoot = req.child ? structuredClone(req.root) : null;
  const child = req.child ? childTransport(req.child) : null;
  const post = (type: "stdout" | "stderr", data: Uint8Array) => {
    if (child) child[type].writeAll(data);
    else ctx.postMessage({ type, data }, [data.buffer]);
  };
  const subprocess = ctx.crossOriginIsolated && typeof SharedArrayBuffer === "function" ? new SubprocessHost({
    budget: req.child?.budget,
    slot: req.child?.slot,
    stdin: req.child?.pipes[0],
    output: (fd, data) => post(fd === 2 ? "stderr" : "stdout", data),
    sync: (snapshot) => mergeFilesystemChanges(fs, snapshot),
    launch: (meta, transport) => {
      const cwd = meta.cwd || req.env.PWD || "/";
      if (fs.lookup(cwd)?.kind !== "dir") throw Object.assign(new Error(`spawn: cwd does not exist: ${cwd}`), { code: "ENOENT" });
      if (!req.spawnBroker) throw Object.assign(new Error("spawn: this worker has no page subprocess broker"), { code: "ENOTSUP" });
      const request: RunRequest = {
        ...req, args: meta.argv, env: { ...meta.env, PWD: cwd },
        root: structuredClone(fs.root), child: transport, net: null, moduleCache: null,
      };
      ctx.postMessage({ type: "spawn", request } satisfies WorkerMessage);
      const control = new Int32Array(transport.control, 0, 4);
      return { terminate: () => { Atomics.store(control, 3, 1); } };
    },
  }) : null;
  const wasi = new Wasi({
    args: req.args,
    env: req.env,
    fs,
    preopens: { "/": "/" },
    stdin: child ? (cap) => child.stdin.readBlocking(cap) : undefined,
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
    subprocess?.dispose();
    compactFs(fs.root);
    if (child && initialRoot) {
      if ("error" in result) child.stderr.writeAll(new TextEncoder().encode(`${describeError(result.error)}\n`));
      child.finish("code" in result ? result.code : 1, filesystemChanges(initialRoot, fs.root));
      return;
    }
    if ("code" in result) {
      ctx.postMessage({ type: "exit", code: result.code, root: fs.root, sleep: sleepMode } satisfies WorkerMessage);
      return;
    }
    const err = result.error;
    const message = describeError(err);
    ctx.postMessage({ type: "error", message, root: fs.root, sleep: sleepMode } satisfies WorkerMessage);
  };
  try {
    const instantiating = perfNow();
    const instance = new WebAssembly.Instance(req.module, wasi.imports(req.module));
    ctx.postMessage({ type: "phase", name: "instantiate", duration: perfNow() - instantiating } satisfies WorkerMessage);
    const slots = req.slots ?? "imports";
    const netHost = req.net ? new NetHost(req.net, sendNet) : null;
    if (slots !== "off") {
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("bun-wasm has no memory");
      netHost?.attach(memory);
      subprocess?.attach(memory);
      const impls = subprocess ? subprocess.slots(netHost?.slots()) : netHost?.slots();
      if (impls && slots === "imports") wasi.hostCall = installHostSlotsViaImport(instance, impls);
      else if (impls) installHostSlots(instance, impls);
    }
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
    const networking = slots !== "off" ? netHost?.engineNet() : undefined;
    const net = slots !== "off" && subprocess ? subprocess.engineNet(networking) : networking;
    const code = await startEngineHost({
      instance,
      moduleUrls: "blob",
      modules: req.moduleCache ? moduleStore(req.moduleCache) : undefined,
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
