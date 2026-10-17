import { createRuntime, type Runtime } from "@bun-wasm/runtime";
import { startRun, type Run } from "../src/runner";
import { createWorkerProcessTransport, workerProcessState } from "@bun-wasm/runtime/proc/worker-client";
import { runtimeProcChecks, runtimeProcFixture, runtimeProcStages, runtimeProcJobWaitChecks, runtimeProcJobWaitFixture, runtimeProcJobWaitStages } from "./runtime-proc-fixtures";

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
// Serialized from TypeScript into a task-owned worker bootstrap. It delegates every ABI call
// unchanged. The descendants' final poll is suspended until the shell's real blocking wait_job
// reaches Atomics.wait; a scheduler pause therefore cannot accidentally turn this into a ready-job
// fast-path test. Observing the actual blocking branch is stronger than an elapsed-time guess.
async function instrumentJobWaitWorker(sourceURL: string) {
  const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
  let gate: Int32Array | undefined, waitingJob: number | undefined, loaded = false;
  const pending: MessageEvent[] = [];
  const nativeWait = Atomics.wait, NativeInstance = WebAssembly.Instance;
  let ioTotal = 0, nextReport = 64, launchReported = false;
  const ioCounts: Record<string, number> = {};
  const reportIO = (call: { operation: "read" | "poll" | "interrupted"; result: number; fd?: number; length?: number; count?: number; timeout?: number }) => {
    ioTotal++;
    const key = `${call.operation}:${call.result}`;
    ioCounts[key] = (ioCounts[key] ?? 0) + 1;
    // Diagnose a busy loop without causing one: at most 32 initial posts, then one per
    // doubling of the call count. Never enqueue one message for every hot ABI import.
    if (ioTotal <= 32 || ioTotal >= nextReport || ioCounts[key] === 1) {
      scope.postMessage({ type: "job-wait-test-io", ...call, total: ioTotal, counts: { ...ioCounts } });
      if (ioTotal >= nextReport) nextReport *= 2;
    }
  };
  scope.addEventListener("message", event => {
    if (!launchReported && event.data?.module instanceof WebAssembly.Module) {
      launchReported = true;
      scope.postMessage({ type: "job-wait-test-launch", args: event.data.args, interruptible: event.data.interruptible,
        slot: event.data.runtimeProcess?.slot });
    }
    if (event.data?.type === "job-wait-test-gate") {
      gate = new Int32Array(event.data.gate as SharedArrayBuffer);
      event.stopImmediatePropagation();
    } else if (!loaded) {
      pending.push(event); event.stopImmediatePropagation();
    }
  });
  Reflect.set(Atomics, "wait", (...args: unknown[]) => {
    if (waitingJob !== undefined && gate && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
      scope.postMessage({ type: "job-wait-test-blocking-entry", job: waitingJob });
      Atomics.notify(gate, 0);
    }
    return Reflect.apply(nativeWait, Atomics, args);
  });
  Reflect.set(WebAssembly, "Instance", class extends NativeInstance {
    constructor(module: WebAssembly.Module, imports: WebAssembly.Imports = {}) {
      const runtime = imports.runtime_proc;
      if (runtime) {
        const waitJob = runtime.wait_job, poll = runtime.poll, read = runtime.read, interrupted = runtime.interrupted;
        // Preserve each return value rather than guessing whether a failed readExact saw EOF,
        // an errno, or a legal zero-ready wake. These messages never change the ABI result.
        if (typeof read === "function") runtime.read = (fd: number, ptr: number, length: number) => {
          const result = Reflect.apply(read, runtime, [fd, ptr, length]);
          reportIO({ operation: "read", fd, length, result });
          return result;
        };
        if (typeof interrupted === "function") runtime.interrupted = () => {
          const result = Reflect.apply(interrupted, runtime, []);
          reportIO({ operation: "interrupted", result });
          return result;
        };
        if (typeof waitJob === "function") runtime.wait_job = (job: number, flags: number, ptr: number) => {
          const previous = waitingJob;
          if (flags === 0) waitingJob = job;
          try { return Reflect.apply(waitJob, runtime, [job, flags, ptr]); }
          finally { waitingJob = previous; }
        };
        if (typeof poll === "function") runtime.poll = (ptr: number, count: number, timeout: number, out: number) => {
          if (count === 0 && timeout === 75) {
            if (!gate) throw new Error("job wait test gate was not installed before guest start");
            const deadline = performance.now() + 10_000;
            while (Atomics.load(gate, 0) === 0) {
              if (performance.now() >= deadline) throw new Error("shell never entered the real blocking wait_job branch");
              Reflect.apply(nativeWait, Atomics, [gate, 0, 0, 10]);
            }
          }
          const result = Reflect.apply(poll, runtime, [ptr, count, timeout, out]);
          reportIO({ operation: "poll", count, timeout, result });
          return result;
        };
      }
      super(module, imports);
    }
  });
  await import(sourceURL);
  loaded = true;
  for (const event of pending) scope.dispatchEvent(new MessageEvent("message", { data: event.data, ports: Array.from(event.ports) }));
  pending.length = 0;
}

const bufferDecode = decodeFingerprint();
const jobWaitScenario = new URLSearchParams(location.search).has("job-wait");
const jobWaitGate = jobWaitScenario ? new SharedArrayBuffer(4) : undefined;
const bootstrapURLs = new Set<string>();
const blockingWaitEntries: number[] = [];
const ioCalls: { worker: number; operation: "read" | "poll" | "interrupted"; result: number; fd?: number; length?: number; count?: number; timeout?: number; total: number; counts: Record<string, number> }[] = [];
const launches: { worker: number; args: string[]; interruptible?: boolean; slot?: number }[] = [];
const spawns: { worker: number; pid: number; parentPid: number; job: number; executable: string; argv: string[] }[] = [];
let ioReports = 0;
const NativeWorker = globalThis.Worker;
const activeWorkers = new Set<Worker>();
const messages: string[] = [];
const exits: { worker: number; type: string; code: number; message?: string }[] = [];
const reaps: { job: number; completedGuests: typeof exits }[] = [];
const workerErrors: { worker: number; message: string; filename: string; lineno: number; colno: number }[] = [];
let workersCreated = 0;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    const sourceURL = new URL(url, location.href);
    let bootstrapURL: string | undefined;
    if (jobWaitGate && /\/(?:preview1-)?worker\.js$/.test(sourceURL.pathname)) {
      bootstrapURL = URL.createObjectURL(new Blob([`await (${instrumentJobWaitWorker.toString()})(${JSON.stringify(sourceURL.href)})`], { type: "text/javascript" }));
      bootstrapURLs.add(bootstrapURL);
    }
    super(bootstrapURL ?? url, options); activeWorkers.add(this); const worker = ++workersCreated;
    this.addEventListener("error", event => {
      workerErrors.push({ worker, message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno });
    });
    this.addEventListener("message", event => {
      const { data } = event;
      if (data.type === "job-wait-test-blocking-entry") {
        blockingWaitEntries.push(data.job); event.stopImmediatePropagation(); return;
      }
      if (data.type === "job-wait-test-launch") {
        if (launches.length < 32) launches.push({ worker, args: data.args, interruptible: data.interruptible, slot: data.slot });
        event.stopImmediatePropagation(); return;
      }
      if (data.type === "job-wait-test-io") {
        const { operation, result, fd, length, count, timeout, total, counts } = data;
        ioReports++;
        if (ioCalls.length === 256) ioCalls.shift();
        ioCalls.push({ worker, operation, result, fd, length, count, timeout, total, counts });
        event.stopImmediatePropagation(); return;
      }
      if (data.type === "runtime-proc") {
        if (data.operation === "spawn" && spawns.length < 32) {
          const { pid, parentPid, job } = workerProcessState(data.transport);
          spawns.push({ worker, pid, parentPid, job, executable: data.request.executable, argv: data.request.argv.slice() });
        }
        messages.push(data.operation);
        // A wait_job reaps synchronously in the guest before its notification reaches this page.
        // Capture prior exit messages here: later stream reads must not hide an early wait return.
        if (data.operation === "reap-job") reaps.push({ job: data.job, completedGuests: exits.slice() });
      }
      if (data.type === "exit" || data.type === "error") exits.push({ worker, type: data.type, code: data.code, message: data.message });
    });
    if (bootstrapURL) this.postMessage({ type: "job-wait-test-gate", gate: jobWaitGate });
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

let runtime: Runtime | undefined;
let run: Run | undefined;
let settled = false;
let result: Record<string, unknown>;
let stdout = "", stderr = "";
try {
  equal(crossOriginIsolated, true, "SharedArrayBuffer isolation");
  runtime = createRuntime({ filesystem: { workerURL: new URL("./fs-worker.js", location.href) } });
  await runtime.filesystem.mkdirp("/home/user"); await runtime.filesystem.flush();
  const parameters = new URLSearchParams(location.search);
  const jobWait = parameters.has("job-wait");
  const checks = jobWait ? runtimeProcJobWaitChecks : runtimeProcChecks;
  const stages = jobWait ? runtimeProcJobWaitStages : runtimeProcStages;
  const module = new WebAssembly.Module(jobWait ? runtimeProcJobWaitFixture() : runtimeProcFixture());
  const explicit = parameters.has("explicit");
  // Omitting runtimeProcess is intentional: a generic root must be recognized from real imports,
  // not only when a privileged caller already knows to manufacture the transport.
  run = startRun({ engine: "browser", adapter: "preview1", module, args: ["abi-parent"], env: { PWD: "/" },
    runtime, moduleScope: false, ...(explicit ? { runtimeProcess: createWorkerProcessTransport({
      pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer,
    }) } : {}) }, {
    stdout(bytes) { stdout += new TextDecoder().decode(bytes); },
    stderr(bytes) { stderr += new TextDecoder().decode(bytes); },
  });
  const completed = run.done.then(value => { settled = true; return value; });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([completed, new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`full guest sequence timed out; operations=${messages.join(",")}`)), 20_000);
  })]).finally(() => { if (timeout) clearTimeout(timeout); });
  equal(outcome.code, 0, `guest exit (${stages[outcome.code] ?? "startup or unknown stage"}); ${outcome.error ?? stderr}`);
  equal(outcome.error, undefined, "guest did not crash");
  equal(stdout, jobWait ? "job-wait-blocking\njob-wait-ok\n" : "child-stdout\nruntime-proc-ok\n", "full guest sequence markers");
  equal(stderr, jobWait ? "" : "child-stderr\n", "inherited stderr target");
  equal(messages.filter(message => message === "pipe").length, jobWait ? 4 : 2, "all guest pipes published to responsive page broker");
  equal(messages.filter(message => message === "spawn").length, jobWait ? 4 : 1, "all guests launched by actual page broker");
  if (jobWait) {
    equal(messages.filter(message => message === "signal").length, 1, "one real foreground job signal");
    equal(exits.length, 5, "shell, leader, descendant, grandchild and background all completed");
    equal(reaps.length, 2, "foreground and independent background both reaped");
    equal(blockingWaitEntries.length, 1, "real wait_job took its blocking branch while descendants remained live");
    equal(blockingWaitEntries[0], reaps[0]!.job, "the real blocking entry waited for the foreground job");
    equal(reaps[0]!.completedGuests.length, 3, "foreground wait returned only after leader, descendant and grandchild actually exited");
    equal(reaps[1]!.completedGuests.length, 4, "background exited only after the foreground wait completed");
    if (reaps[0]!.job === reaps[1]!.job) throw new Error("background must have a separate job identity");
    for (const exit of exits) equal(exit.type, "exit", "all guests exit normally");
    equal(exits.map(exit => exit.code).sort((a, b) => a - b).join(","), "0,0,0,31,32", "descendants retain distinct ordinary exits while shell preserves leader zero");
    equal(reaps[0]!.completedGuests.map(exit => exit.code).sort((a, b) => a - b).join(","), "0,31,32", "foreground result is not the last descendant status");
  }
  if (workersCreated < (jobWait ? 6 : 3)) throw new Error(`expected real filesystem and all guest workers, saw ${workersCreated}`);
  // Completion acknowledges guest descriptor release. The run and broker must stop both guests.
  await until(() => activeWorkers.size === 1, "completed guests terminated before filesystem disposal");
  await runtime.dispose(); runtime = undefined;
  await until(() => activeWorkers.size === 0, "all task-created workers terminated");
  result = { ok: true, mode: explicit ? "explicit" : "automatic", scenario: jobWait ? "job-wait" : "pipes", checks, stdout,
    messages, exits, reaps, blockingWaitEntries, ioCalls, ioReports, launches, spawns, workerErrors, bufferDecode, cleanup: { activeWorkers: activeWorkers.size, workersCreated } };
} catch (error) {
  result = { ok: false, stdout, stderr, messages, exits, reaps, blockingWaitEntries, ioCalls, ioReports, launches, spawns, workerErrors, bufferDecode,
    error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error) };
} finally {
  if (run && !settled) {
    run.kill(9);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run.done, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })])
      .finally(() => { if (timeout) clearTimeout(timeout); });
  }
  let teardownError: string | undefined;
  try { await runtime?.dispose(); }
  catch (error) { teardownError = String(error); result = { ...result!, ok: false, teardownError }; }
  const forcedWorkers = activeWorkers.size;
  for (const worker of activeWorkers) worker.terminate();
  for (const url of bootstrapURLs) URL.revokeObjectURL(url);
  bootstrapURLs.clear();
  globalThis.Worker = NativeWorker;
  Object.assign(globalThis, { runtimeProcResult: { ...result!, teardown: { forcedWorkers, activeWorkers: activeWorkers.size, error: teardownError } } });
}
