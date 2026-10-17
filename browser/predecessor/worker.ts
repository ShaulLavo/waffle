// Bun executor policy over the reusable browser process bootstrap.
import { startEngineHost } from "./engine-host.js";
import { createFilesystemIdentity, revokeFilesystem, sharedRevoked, type FilesystemIdentity } from "@bun-wasm/runtime/fs";
import { NetHost } from "./net/host";
import type { NetRequest } from "./net/protocol";
import { HOST_CALL_FD, installHostSlots, installHostSlotsViaImport } from "./net/trampoline";
import type { WorkerProcessMessage } from "@bun-wasm/runtime/proc/worker-client";
import { readOutcome, outcomeWord } from "@bun-wasm/runtime/proc/outcome";
import { bootstrap, type RuntimeWorkerRequest, type WorkerExecutor } from "@bun-wasm/runtime/browser/worker";
import { SubprocessHost, childTransport, wasiPipe, type ChildTransport } from "./subprocess.ts";
import { DefaultSignal } from "./default-signal";

export type Engine = "quickjs" | "jsc" | "browser";

export interface RunRequest extends RuntimeWorkerRequest {
  engine: Engine;
  adapter?: "bun" | "preview1";
  pid?: number;
  jobId?: number;
  identity?: SharedArrayBuffer;
  interrupt?: SharedArrayBuffer;
  /** Page-visible legacy host-poll readiness word, including generic Bun workers. */
  budget?: SharedArrayBuffer;
  requestedSignal?: SharedArrayBuffer;
  signalState?: SharedArrayBuffer;
  outcome?: SharedArrayBuffer;
  trace: boolean;
  /** The networking ring (net/ring.ts); null when the page is not cross-origin isolated. */
  net: SharedArrayBuffer | null;
  /**
   * Browser engine: the Cache Storage cache for import cycles, served by the service worker
   * under ./m/. Acyclic modules use blob URLs. Null disables import cycles.
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
  const openCache = caches.open.bind(caches, cacheName);
  let cache: Promise<Cache> | undefined;
  return {
    url: (key: string) => base + encodeURIComponent(key),
    put: async (url: string, source: string) => {
      const headers = { "content-type": "text/javascript; charset=utf-8" };
      const store = await (cache ??= openCache());
      await store.put(url, new NativeResponse(source, { headers }));
    },
  };
}

export interface SpawnRequest {
  executable: string;
  argv: string[];
  pid: number;
  parentPid: number;
  jobId: number;
  /** Preserve 0/-1 new-job intent separately from the pre-reserved job id. */
  job?: number;
  cwd: string;
  env: Record<string, string>;
  filesystem: FilesystemIdentity;
  child: ChildTransport;
  trace: boolean;
  slots?: RunRequest["slots"];
  spawnBroker: true;
}

export type WorkerMessage =
  | WorkerProcessMessage
  | { type: "spawn"; request: SpawnRequest }
  | { type: "child-close"; pid: number; parentPid: number }
  | { type: "phase"; name: string; duration: number }
  | { type: "stdout"; data: Uint8Array }
  | { type: "stderr"; data: Uint8Array }
  | { type: "net"; req: NetRequest }
  | { type: "exit"; code: number; signal?: number; sleep: SleepMode }
  | { type: "default-signal"; signal: number }
  | { type: "error"; code: number; message: string; sleep: SleepMode };

export type SleepMode = "atomics" | "busy-wait";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// The engines' default stack budgets are measured on V8, whose first wasm tier uses frames close to
// its optimized ones. JavaScriptCore starts in an interpreter with frames up to three times larger,
// in 512 KiB worker stacks on Apple platforms, so other engines get the budgets measured there
// (docs/stack-limits.md). V8 is the engine whose stack traces have "    at " frames.
const smallStackKib: Partial<Record<Engine, string>> | null = /\n\s+at /.test(new Error().stack ?? "")
  ? null
  : { quickjs: "32", jsc: "192" };

function guestEnv(req: RunRequest): Record<string, string> {
  const kib = smallStackKib?.[req.engine];
  if (!kib || "BUN_WASM_STACK_KIB" in req.env) return req.env;
  return { ...req.env, BUN_WASM_STACK_KIB: kib };
}

const sendNet = (req: NetRequest, transfer: Transferable[] = []) => ctx.postMessage({ type: "net", req } satisfies WorkerMessage, transfer);

/** Bun's engine and legacy child adapter stay out of the preview1 entry graph. */
function bunExecutor(req: RunRequest): WorkerExecutor<RunRequest> {
  const child = req.child ? childTransport(req.child) : null;
  let subprocess: SubprocessHost | null = null;
  let netHost: NetHost | null = null;
  const slots = req.adapter === "preview1" ? "off" : req.slots ?? "imports";
  return {
    hostCallFd: HOST_CALL_FD,
    env: guestEnv,
    outcome: req.child?.outcome ?? req.outcome,
    requestedSignal: req.child?.requestedSignal ?? req.requestedSignal,
    interrupt: req.child?.interrupt ?? req.interrupt,
    stdio: child ? { 0: wasiPipe(child.stdin, "read"), 1: wasiPipe(child.stdout, "write"), 2: wasiPipe(child.stderr, "write") } : undefined,
    signalError(signal): never { throw new DefaultSignal(signal); },
    terminalSignal: error => error instanceof DefaultSignal ? error.signal : undefined,
    signal: (signal, mode) => subprocess?.signal(signal, mode) ?? -38,
    beforeFinish: () => subprocess?.detach(),
    diagnostic: child ? message => { child.stderr.writeAll(new TextEncoder().encode(message)); } : undefined,
    complete: child ? (code, signal) => {
      child.finish(code, signal);
      return readOutcome(outcomeWord(req.child!.outcome))!;
    } : undefined,
    setup({ fs, isolated, runtimeState, interrupt, outcome, defaultSignal, post }) {
      subprocess = isolated ? new SubprocessHost({
        signalState: runtimeState?.signals.signalState ?? req.child?.signalState ?? req.signalState,
        interrupt, outcome: outcome ?? undefined, defaultSignal,
        budget: req.child?.budget ?? req.budget,
        identity: req.runtimeProcess?.identity ?? req.child?.identity ?? req.identity,
        pid: runtimeState?.pid ?? req.child?.pid ?? req.pid,
        jobId: runtimeState?.job ?? req.child?.jobId ?? req.jobId,
        workerTransport: req.child, slot: req.child?.slot, token: req.child?.token,
        stdin: req.child?.pipes[0], revoked: sharedRevoked(req.filesystem),
        onChildClose: pid => ctx.postMessage({ type: "child-close", pid, parentPid: runtimeState?.pid ?? req.child?.pid ?? req.pid ?? 1 } satisfies WorkerMessage),
        output: (fd, data) => post(fd === 2 ? "stderr" : "stdout", data),
        launch: (meta, transport) => {
          const cwd = meta.cwd || req.env.PWD || "/";
          if (fs.lookup(cwd)?.kind !== "dir") throw Object.assign(new Error(`spawn: cwd does not exist: ${cwd}`), { code: "ENOENT" });
          if (!req.spawnBroker) throw Object.assign(new Error("spawn: this worker has no page subprocess broker"), { code: "ENOTSUP" });
          // Process ancestry is not capability ancestry: another job may outlive this parent.
          const filesystem = createFilesystemIdentity({ ...fs.connection, revocations: fs.connection.revocations.slice(-1) });
          const request: SpawnRequest = {
            executable: meta.executable ?? meta.argv[0]!, argv: meta.argv, cwd,
            pid: transport.pid, parentPid: transport.parentPid, jobId: transport.jobId, job: meta.job ?? transport.jobId,
            env: { ...meta.env, PWD: cwd }, filesystem, child: transport,
            trace: req.trace, slots: req.slots, spawnBroker: true,
          };
          ctx.postMessage({ type: "spawn", request } satisfies WorkerMessage);
          const control = new Int32Array(transport.control, 0, 4);
          return {
            revoke: () => { revokeFilesystem(filesystem); fs.sweep(); },
            terminate: () => { Atomics.store(control, 3, 1); },
          };
        },
      }) : null;
    },
    instantiated({ instance, wasi, fs }) {
      netHost = req.net ? new NetHost(req.net, sendNet, (path, bytes) => fs.writeFile(path, bytes)) : null;
      if (slots === "off") return;
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("bun-wasm has no memory");
      netHost?.attach(memory);
      subprocess?.attach(memory);
      const impls = subprocess ? subprocess.slots(netHost?.slots()) : netHost?.slots();
      if (impls && slots === "imports") wasi.hostCall = installHostSlotsViaImport(instance, impls);
      else if (impls) installHostSlots(instance, impls);
    },
    run({ instance, checkActive, finish }, exited) {
      const ready = instance.exports.bunwasm_ready as (() => number) | undefined;
      if (exited !== null || req.adapter === "preview1" || req.engine !== "browser" || ready?.() !== 1) return exited ?? 0;
      const networking = slots !== "off" ? netHost?.engineNet() : undefined;
      const net = slots !== "off" && subprocess ? subprocess.engineNet(networking) : networking;
      const nativeFetch = ctx.fetch.bind(ctx);
      return startEngineHost({
        instance, moduleUrls: "blob",
        modules: req.moduleCache ? moduleStore(req.moduleCache) : undefined,
        fetch: (input, init) => { checkActive(); return nativeFetch(input, init); },
        net, onExit: code => finish({ code }),
      });
    },
  };
}

ctx.onmessage = (event: MessageEvent<RunRequest>) => bootstrap(event.data, bunExecutor(event.data), ctx);
