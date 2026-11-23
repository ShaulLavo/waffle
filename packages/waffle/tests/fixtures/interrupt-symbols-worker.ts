import { describeWorkerError } from "../../browser/worker.js";
import { Wasi } from "../../core/wasi.js";
import { MemFS } from "../../fs/memory.js";
import { adoptLinkPlan, instantiateLinkPlan, type SharedLinkPlan } from "../../link/index.js";

export interface WorkerTrapResult {
  readonly name: string;
  readonly message: string;
  readonly rawStack: string;
  readonly workerText: string;
}

export type SymbolsWorkerRequest =
  | {
      readonly mode: "direct";
      readonly module: WebAssembly.Module;
      readonly action: "start" | "div0" | "recurse";
      readonly depth?: number;
      readonly stackTraceLimit?: number;
    }
  | {
      readonly mode: "bridge";
      readonly primary: WebAssembly.Module;
      readonly secondary: WebAssembly.Module;
      readonly secondaryEntry: "outer" | "helper_outer" | "run";
    }
  | {
      readonly mode: "linked";
      readonly plan: SharedLinkPlan;
    };

function captureTrap(error: unknown): WorkerTrapResult {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    name: err.name,
    message: err.message,
    rawStack: err.stack ?? "",
    workerText: describeWorkerError(err),
  };
}

function makeImports(module: WebAssembly.Module, bridge: () => void): WebAssembly.Imports {
  const imports: WebAssembly.Imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    const ns = (imports[entry.module] ??= {});
    if (entry.kind === "memory" && entry.module === "env" && entry.name === "memory") {
      ns[entry.name] = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    } else if (entry.module === "wasi_snapshot_preview1" && entry.name === "proc_exit") {
      ns[entry.name] = () => {};
    } else if (entry.module === "env" && (entry.name === "host_bridge" || entry.name === "cb")) {
      ns[entry.name] = bridge;
    } else if (entry.module === "env" && entry.name.startsWith("imp_")) {
      ns[entry.name] = () => {};
    } else if (entry.module === "runtime_proc" && entry.name === "__waffle_fatal") {
      ns[entry.name] = () => 0;
    } else if (
      entry.module === "runtime_proc" &&
      (entry.name === "__waffle_wait32" || entry.name === "__waffle_wait64")
    ) {
      ns[entry.name] = () => 0;
    }
  }
  return imports;
}

function runDirect(req: Extract<SymbolsWorkerRequest, { mode: "direct" }>): WorkerTrapResult {
  const instance = new WebAssembly.Instance(
    req.module,
    makeImports(req.module, () => {}),
  );
  const ErrorWithLimit = Error as unknown as { stackTraceLimit?: number };
  const hadLimit = "stackTraceLimit" in ErrorWithLimit;
  const previousLimit = ErrorWithLimit.stackTraceLimit;
  if (req.stackTraceLimit !== undefined) ErrorWithLimit.stackTraceLimit = req.stackTraceLimit;
  try {
    try {
      if (req.action === "start") {
        ((instance.exports._start ?? instance.exports.run) as () => void)();
      } else if (req.action === "div0") {
        (instance.exports.trap_div0 as () => void)();
      } else {
        (instance.exports.recurse as (n: number) => void)(req.depth ?? 5);
      }
      throw new Error("expected Wasm trap did not occur");
    } catch (error) {
      return captureTrap(error);
    }
  } finally {
    if (req.stackTraceLimit !== undefined) {
      if (hadLimit) ErrorWithLimit.stackTraceLimit = previousLimit;
      else delete ErrorWithLimit.stackTraceLimit;
    }
  }
}

function runBridge(req: Extract<SymbolsWorkerRequest, { mode: "bridge" }>): WorkerTrapResult {
  const secondaryInstance = new WebAssembly.Instance(
    req.secondary,
    makeImports(req.secondary, () => {}),
  );
  const primaryBridge = () => {
    (secondaryInstance.exports[req.secondaryEntry] as () => void)();
  };
  const primaryInstance = new WebAssembly.Instance(
    req.primary,
    makeImports(req.primary, primaryBridge),
  );
  try {
    (primaryInstance.exports.call_bridge as () => void)();
    throw new Error("expected bridge trap did not occur");
  } catch (error) {
    return captureTrap(error);
  }
}

function runLinked(req: Extract<SymbolsWorkerRequest, { mode: "linked" }>): WorkerTrapResult {
  const plan = adoptLinkPlan(req.plan);
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    namespaces: { env: { check: () => {} } },
  });
  const linked = instantiateLinkPlan(plan, { wasi, checkActive() {} });
  try {
    linked.initialize();
    const tableBase = linked.libraries[0]!.tableBase;
    (linked.entry.exports.call_side as (slot: number) => number)(tableBase);
    throw new Error("expected linked trap did not occur");
  } catch (error) {
    return captureTrap(error);
  } finally {
    linked.dispose();
  }
}

self.onmessage = ({ data }: MessageEvent<SymbolsWorkerRequest>) => {
  try {
    const result =
      data.mode === "direct"
        ? runDirect(data)
        : data.mode === "bridge"
          ? runBridge(data)
          : runLinked(data);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: captureTrap(error) });
  }
};
