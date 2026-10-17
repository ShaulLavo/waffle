import { SharedFilesystem } from "../src/shared-fs";
import { startRun, type Run } from "../src/runner";
import { createWorkerProcessTransport } from "../../runtime/proc/worker-client";
import { runtimeProcChecks, runtimeProcFixture, runtimeProcStages } from "./runtime-proc-fixtures";

// Diagnostic only: identify the exact BufferSource representation rejected by an engine.
// This never changes the guest, retries an operation, or relaxes a process assertion.
function decodeFingerprint() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const convert = Reflect.get(memory, "toResizableBuffer");
  if (typeof convert !== "function") return { available: false };
  try {
    const buffer = Reflect.apply(convert, memory, []) as ArrayBuffer;
    const bytes = new Uint8Array(buffer, 0, 2); bytes.set([123, 125]);
    const decode = (input: Uint8Array) => {
      try { return { value: new TextDecoder("utf-8", { fatal: true }).decode(input) }; }
      catch (error) { return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }; }
    };
    return { available: true, resizable: Reflect.get(buffer, "resizable"), direct: decode(bytes), fixed: decode(bytes.slice()) };
  } catch (error) {
    return { available: true, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
const bufferDecode = decodeFingerprint();
const NativeWorker = globalThis.Worker;
const activeWorkers = new Set<Worker>();
const messages: string[] = [];
const exits: { worker: number; type: string; code: number; message?: string }[] = [];
const workerErrors: { worker: number; message: string; filename: string; lineno: number; colno: number }[] = [];
let workersCreated = 0;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); activeWorkers.add(this); const worker = ++workersCreated;
    this.addEventListener("error", event => {
      workerErrors.push({ worker, message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno });
    });
    this.addEventListener("message", ({ data }) => {
      if (data.type === "runtime-proc") messages.push(data.operation);
      if (data.type === "exit" || data.type === "error") exits.push({ worker, type: data.type, code: data.code, message: data.message });
    });
  }
  override terminate() { activeWorkers.delete(this); super.terminate(); }
};
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1));
function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
async function until(condition: () => boolean, label: string) {
  const deadline = performance.now() + 10_000;
  while (!condition()) { if (performance.now() >= deadline) throw new Error(`${label} timed out`); await pause(); }
}

let filesystem: SharedFilesystem | undefined;
let run: Run | undefined;
let settled = false;
let result: Record<string, unknown>;
let stdout = "", stderr = "";
try {
  equal(crossOriginIsolated, true, "SharedArrayBuffer isolation");
  filesystem = new SharedFilesystem();
  await filesystem.mkdirp("/home/user"); await filesystem.flush();
  const module = new WebAssembly.Module(runtimeProcFixture());
  const explicit = new URLSearchParams(location.search).has("explicit");
  // Omitting runtimeProcess is intentional: a generic root must be recognized from real imports,
  // not only when a privileged caller already knows to manufacture the transport.
  run = startRun({ engine: "browser", adapter: "preview1", module, args: ["abi-parent"], env: { PWD: "/" },
    filesystem, moduleScope: false, ...(explicit ? { runtimeProcess: createWorkerProcessTransport() } : {}) }, {
    stdout(bytes) { stdout += new TextDecoder().decode(bytes); },
    stderr(bytes) { stderr += new TextDecoder().decode(bytes); },
  });
  const completed = run.done.then(value => { settled = true; return value; });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([completed, new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`full guest sequence timed out; operations=${messages.join(",")}`)), 20_000);
  })]).finally(() => { if (timeout) clearTimeout(timeout); });
  equal(outcome.code, 0, `guest exit (${runtimeProcStages[outcome.code] ?? "startup or unknown stage"}); ${outcome.error ?? stderr}`);
  equal(outcome.error, undefined, "guest did not crash");
  equal(stdout, "child-stdout\nruntime-proc-ok\n", "inherited stdout and full parent/child guest sequence marker");
  equal(stderr, "child-stderr\n", "inherited stderr target");
  equal(messages.filter(message => message === "pipe").length, 2, "both pipes published to responsive page broker");
  equal(messages.filter(message => message === "spawn").length, 1, "child launched by actual page broker");
  if (workersCreated < 3) throw new Error(`expected real filesystem, root and child workers, saw ${workersCreated}`);
  // Completion acknowledges guest descriptor release. The run and broker must stop both guests.
  await until(() => activeWorkers.size === 1, "completed guests terminated before filesystem disposal");
  filesystem.dispose(); filesystem = undefined;
  await until(() => activeWorkers.size === 0, "all task-created workers terminated");
  result = { ok: true, mode: explicit ? "explicit" : "automatic", checks: runtimeProcChecks, stdout,
    messages, exits, workerErrors, bufferDecode, cleanup: { activeWorkers: activeWorkers.size, workersCreated } };
} catch (error) {
  result = { ok: false, stdout, stderr, messages, exits, workerErrors, bufferDecode,
    error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error) };
} finally {
  if (run && !settled) {
    run.kill(9);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run.done, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })])
      .finally(() => { if (timeout) clearTimeout(timeout); });
  }
  filesystem?.dispose();
  const forcedWorkers = activeWorkers.size;
  for (const worker of activeWorkers) worker.terminate();
  globalThis.Worker = NativeWorker;
  Object.assign(globalThis, { runtimeProcResult: { ...result!, teardown: { forcedWorkers, activeWorkers: activeWorkers.size } } });
}
