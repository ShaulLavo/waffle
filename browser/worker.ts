import { ExecutionUnwind } from "../core/unwind.js";
import { directoryState, isCollectedProcess } from "../proc/directory.js";
import { type ControlCells, controlLoad, controlWait } from "../proc/control.js";
import type { OutcomeWord } from "../proc/outcome.js";
// Process bootstrap shared by preview1 commands and injected guest executors.
import { checkedSignal, ProcessError } from "../proc/types.js";
import { defaultSignalTerminates, signalPending } from "../proc/signals.js";
import { FilesystemClient, revokeFilesystem, reapFilesystem, sharedRevoked, type FilesystemConnection } from "../fs/index.js";
import { Wasi, WasiExit, type Stream } from "../core/index.js";
import { guardedStream } from "./guarded-stream.js";
import { withFileOffset } from "../core/open-file.js";
import { claimOutcome, outcomeWord, processOutcome, readOutcome } from "../proc/outcome.js";
import { ExecutableFormatError, startFailure, type StartFailure } from "../proc/start-failure.js";
import { waitStatus } from "../proc/wait-status.js";
import type { ProcessExit } from "../proc/types.js";
import { fatalInterrupt } from "../interrupt/check.js";
import type { WorkerProcessClient, WorkerProcessMessage, WorkerProcessTransport, workerProcessState } from "../proc/worker-client.js";

export interface RuntimeWorkerRequest {
  module: WebAssembly.Module;
  args: string[];
  env: Record<string, string>;
  filesystem: FilesystemConnection;
  runtimeProcess?: WorkerProcessTransport;
  /** Authoritative terminal word available before loading process adapters. */
  outcome?: SharedArrayBuffer | OutcomeWord;
  /** Admitted code with fatal-only instrumentation, not an admission bypass. */
  interruptible?: boolean;
  trace?: boolean;
}

export type SleepMode = "atomics" | "busy-wait";
export type RuntimeWorkerMessage = WorkerProcessMessage
  | { type: "phase"; name: string; duration: number }
  | { type: "stdout" | "stderr"; data: Uint8Array }
  | { type: "exit"; code: number; signal?: number; sleep?: SleepMode; cleanupErrors?: string[] }
  | { type: "error"; code: number; errno?: StartFailure; message: string; sleep?: SleepMode; cleanupErrors?: string[] }
  /** Owned-resource release failed: diagnostic only, never a quiescence acknowledgement. */
  | { type: "cleanup-error"; code: number; signal?: number; message: string; cleanupErrors: string[]; sleep?: SleepMode }
  | { type: "default-signal"; signal: number };

export interface RuntimeWorkerHost {
  readonly crossOriginIsolated: boolean;
  postMessage(message: RuntimeWorkerMessage, transfer?: Transferable[]): void;
  addEventListener?(type: "error" | "unhandledrejection", listener: (event: WorkerTerminalEvent) => void): void;
  removeEventListener?(type: "error" | "unhandledrejection", listener: (event: WorkerTerminalEvent) => void): void;
}
interface WorkerTerminalEvent { error?: unknown; reason?: unknown; preventDefault(): void }
export type WorkerResult = { code: number; signal?: number } | { error: unknown };
export type RuntimeWorkerState = ReturnType<typeof workerProcessState>;

export interface WorkerSetupContext<R extends RuntimeWorkerRequest = RuntimeWorkerRequest> {
  request: R;
  fs: FilesystemClient;
  isolated: boolean;
  outcome: OutcomeWord | null;
  interrupt?: ControlCells;
  runtimeState: RuntimeWorkerState | null;
  checkActive(): void;
  defaultSignal(signal: number): void;
  post(type: "stdout" | "stderr", data: Uint8Array): boolean;
  finish(result: WorkerResult): void;
}
export interface WorkerBindingsContext<R extends RuntimeWorkerRequest = RuntimeWorkerRequest> extends WorkerSetupContext<R> {
  wasi: Wasi;
}
export interface WorkerExecutionContext<R extends RuntimeWorkerRequest = RuntimeWorkerRequest> extends WorkerBindingsContext<R> {
  instance: WebAssembly.Instance;
}

/** Guest policy stays with the executor, without making its engine bindings, transports or
 * module cache part of the bootstrap. Optional hooks run only in the spawned worker. */
export interface WorkerExecutor<R extends RuntimeWorkerRequest = RuntimeWorkerRequest> {
  hostCallFd?: number;
  env?(request: R): Record<string, string>;
  outcome?: SharedArrayBuffer | OutcomeWord;
  requestedSignal?: SharedArrayBuffer;
  interrupt?: SharedArrayBuffer;
  /** Nonconsuming handled/fatal readiness. Required for executor-owned signal transports
   * (interrupt, requestedSignal or signal) when request.runtimeProcess is absent. */
  interruptPending?(): boolean;
  stdio?: Partial<Record<0 | 1 | 2, Stream>>;
  setup?(context: WorkerSetupContext<R>): void;
  /** Extra import namespaces. The runtime_proc namespace remains owned by Waffle. */
  namespaces?(context: WorkerSetupContext<R>): WebAssembly.Imports;
  /** Runs after default stdio/root preopen creation, before inherited descriptor binding.
   * If relocating preopens, preserve wasi-libc's contiguous discovery scan from fd3 upward:
   * it stops at the first non-preopen. No relocation happens by default. */
  beforeBindings?(context: WorkerBindingsContext<R>): void;
  /** Mutate or replace the linked import object, after bindings and before instantiation. */
  imports?(imports: WebAssembly.Imports, context: WorkerBindingsContext<R>): WebAssembly.Imports | void;
  /** Structured-cloneable child metadata; filesystem and pipeRegistry are reserved. */
  spawnData?(): Record<string, unknown>;
  /** Resolve inherited terminal provenance to a process-local stream. */
  resolveTerminal?(target: 0 | 1 | 2): Stream;
  signal?(signal: number, mode: number): number;
  signalError?(signal: number): never;
  terminalSignal?(error: unknown): number | undefined;
  beforeFinish?(): void;
  diagnostic?(message: string): void;
  /** Runs after descriptors/filesystem have been released, before the exit acknowledgement. */
  complete?(code: number, signal?: number): ProcessExit;
  instantiated?(context: WorkerExecutionContext<R>): void;
  run(context: WorkerExecutionContext<R>, exited: number | null): number | Promise<number>;
}

export class RuntimeWorkerSignal extends ExecutionUnwind {
  constructor(readonly signal: number) { super(`Process stopped by signal ${signal}`); }
}

// Keep the native clock before an executor can install guest-side globals.
const perfNow = performance.now.bind(performance);

/** `Name: message` plus the first stack frames. */
export function describeWorkerError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const head = `${err.name}: ${err.message}`;
  const frames = (err.stack ?? "").split("\n").filter(line => line.trim() && !line.includes(err.message)).slice(0, 15);
  return frames.length ? `${head}\n${frames.map(frame => `    ${frame.trim()}`).join("\n")}` : head;
}

/** Instantiate one process using explicit capabilities; never creates a page runtime. */
export async function bootstrap<R extends RuntimeWorkerRequest>(
  req: R,
  executor: WorkerExecutor<R>,
  host: RuntimeWorkerHost = globalThis as unknown as RuntimeWorkerHost,
): Promise<void> {
  host.postMessage({ type: "phase", name: "worker-start", duration: 0 });
  const fs = new FilesystemClient(req.filesystem);
  let runtimeProcess: WorkerProcessClient | null = null;
  let processSignalExit: typeof import("../proc/abi.js").ProcessSignalExit | undefined;
  const isolated = host.crossOriginIsolated && typeof SharedArrayBuffer === "function";
  const sleepCell = isolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
  const sleepMode: SleepMode = sleepCell ? "atomics" : "busy-wait";
  // A delayed physical Worker can start after its process incarnation was collected.
  // Acquire shared authority inside the cleanup boundary, not after opening fs but before try.
  let outcome: OutcomeWord | null = null;
  let requestedSignal: ControlCells | undefined = executor.requestedSignal ? new Int32Array(executor.requestedSignal) : undefined;
  const revoked = sharedRevoked(req.filesystem);
  let localOutcome: ProcessExit | null = null;
  const detachCollectedProcess = (error: unknown): void => {
    if (!isCollectedProcess(error)) throw error;
    // Shared authority can disappear during asynchronous adapter loading, too. Only local
    // cleanup/reporting remains valid; never send an exit for the slot's new incarnation.
    outcome = null; runtimeProcess = null; requestedSignal = undefined;
  };
  const claim = (result: Pick<ProcessExit, "kind" | "code">): ProcessExit => {
    try { if (outcome) return claimOutcome(outcome, result); }
    catch (error) { detachCollectedProcess(error); }
    return localOutcome ??= processOutcome(result);
  };
  const defaultSignal = (signal: number): void => {
    checkedSignal(signal);
    const killed = requestedSignal && controlLoad(requestedSignal, 0) === 9;
    if (!(outcome ? readOutcome(outcome) : localOutcome) && !killed && !defaultSignalTerminates(signal)) return;
    const winner = claim({ kind: "signaled", code: killed ? 9 : signal });
    if (winner.kind !== "signaled") throw new WasiExit(waitStatus(winner));
    runtimeProcess?.defaultSignal(runtimeProcess.pid, winner.code);
    revokeFilesystem(fs.connection);
    // Logical death is not an acknowledgement that filesystem references were released.
    if (!outcome && winner.kind === "signaled") host.postMessage({ type: "default-signal", signal: winner.code });
    if (executor.signalError) return executor.signalError(winner.code);
    throw new RuntimeWorkerSignal(winner.code);
  };
  const checkActive = () => {
    const winner = outcome ? readOutcome(outcome) : localOutcome;
    if (winner?.kind === "signaled") defaultSignal(winner.code);
    if (winner) throw new WasiExit(waitStatus(winner));
    if (revoked()) throw new WasiExit(1);
  };
  // Ownership begins before setup/namespaces can fail or finish the process.
  const ownedStdio = executor.stdio ? { ...executor.stdio } : undefined;
  let wasi: Wasi | null = null;
  let done = false;
  let started = false;
  const finish = (result: WorkerResult) => {
    if (done) return;
    done = true;
    let settled = localOutcome;
    try { if (outcome) settled = readOutcome(outcome); }
    catch (error) { detachCollectedProcess(error); }
    const ownCode = "code" in result ? result.code : started ? 1 : 126;
    const ownSignal = "signal" in result ? result.signal : undefined;
    const startupFailure = "error" in result && !started;
    const ownResult: Pick<ProcessExit, "kind" | "code"> = startupFailure ? startFailure(result.error)
      : ownSignal === undefined ? { kind: "exited", code: ownCode } : { kind: "signaled", code: ownSignal };
    // Generic commands select their winner before any reentrant cleanup callback. Legacy
    // transports still publish completion only after their buffered diagnostics and release.
    let winner = executor.complete ? settled : claim(ownResult);
    const cleanupErrors: string[] = [];
    const collect = (error: unknown): void => {
      if (error instanceof AggregateError && error.errors.length) for (const cause of error.errors) collect(cause);
      else cleanupErrors.push(describeWorkerError(error));
    };
    const attempt = (cleanup: () => void): boolean => {
      try { cleanup(); return true; } catch (error) { collect(error); return false; }
    };
    attempt(() => executor.beforeFinish?.());
    // Legacy transports must buffer diagnostics before publishing logical completion.
    if (executor.complete && "error" in result && !settled) {
      attempt(() => executor.diagnostic?.(`${describeWorkerError(result.error)}\n`));
    }
    if (executor.complete && startupFailure) winner = claim(ownResult);
    const descriptorsReleased = attempt(() => {
      if (wasi) { wasi.descriptors.dispose(); return; }
      const errors: unknown[] = [];
      for (const fd of [0, 1, 2] as const) {
        try { ownedStdio?.[fd]?.close?.(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "stdio release failed");
    });
    const filesystemReleased = attempt(() => fs.dispose());
    if (!descriptorsReleased || !filesystemReleased) {
      // A failed local release cannot certify quiescence. Leave completion unpublished so
      // the page must fence this process before termination or releasing inherited refs.
      winner ??= claim(ownResult);
      host.postMessage({ type: "cleanup-error", code: waitStatus(winner),
        signal: winner.kind === "signaled" ? winner.code : undefined,
        message: cleanupErrors.join("\n"), cleanupErrors, sleep: sleepMode });
      return;
    }
    if (executor.complete) attempt(() => { winner = executor.complete!(ownCode, ownSignal); });
    winner ??= claim(ownResult);
    const code = waitStatus(winner);
    const signal = winner.kind === "signaled" ? winner.code : undefined;
    if (!executor.complete) attempt(() => runtimeProcess?.exit(code));
    const diagnostics = cleanupErrors.length ? { cleanupErrors } : {};
    if (executor.complete || "code" in result || settled || winner.kind === "signaled") {
      host.postMessage({ type: "exit", code, signal, sleep: sleepMode, ...diagnostics });
    } else {
      host.postMessage({ type: "error", code, errno: winner.kind === "start-failed" ? winner.error : undefined, message: describeWorkerError(result.error), sleep: sleepMode, ...diagnostics });
    }
  };
  const terminalResult = (error: unknown): { code: number; signal?: number } | null => {
    if (error instanceof WasiExit) return { code: error.code };
    const signal = error instanceof RuntimeWorkerSignal || (processSignalExit && error instanceof processSignalExit)
      ? error.signal : executor.terminalSignal?.(error);
    return signal === undefined ? null : { code: 128 + signal, signal };
  };
  const onError = (event: WorkerTerminalEvent) => {
    const result = terminalResult(event.error);
    if (result) { event.preventDefault(); finish(result); }
  };
  const onRejection = (event: WorkerTerminalEvent) => {
    const result = terminalResult(event.reason);
    if (result) { event.preventDefault(); finish(result); }
  };
  try {
    // A valid process must publish even its first adapter-import failure to shared state.
    // Keep this synchronous, while still routing a stale incarnation through finish().
    const sharedOutcome = req.runtimeProcess ? directoryState(req.runtimeProcess).signals.outcome : req.outcome ?? executor.outcome;
    outcome = sharedOutcome || isolated ? outcomeWord(sharedOutcome) : null;
    const runtime = req.runtimeProcess ? await import("../proc/worker-client.js") : null;
    const runtimeState = req.runtimeProcess ? runtime!.workerProcessState(req.runtimeProcess) : null;
    if (!runtimeState && (executor.interrupt || executor.requestedSignal || executor.signal) && typeof executor.interruptPending !== "function") {
      throw new TypeError("WorkerExecutor.interruptPending is required for executor-owned signal transports");
    }
    const interrupt = runtimeState?.signals.interrupt ?? (executor.interrupt ? new Int32Array(executor.interrupt) : undefined);
    if (runtimeState) {
      outcome = runtimeState.signals.outcome;
      requestedSignal = runtimeState.signals.requestedSignal;
    }
    const stdio = ownedStdio ? {
      ...(ownedStdio[0] ? { 0: guardedStream(ownedStdio[0], checkActive) } : {}),
      ...(ownedStdio[1] ? { 1: guardedStream(ownedStdio[1], checkActive) } : {}),
      ...(ownedStdio[2] ? { 2: guardedStream(ownedStdio[2], checkActive) } : {}),
    } : undefined;
    // Default terminal descriptions must post directly: routing their callbacks back through
    // the live fd would recurse, or send an inherited terminal into a redirected file.
    const output = (type: "stdout" | "stderr", data: Uint8Array) => {
      checkActive();
      host.postMessage({ type, data }, [data.buffer as ArrayBuffer]);
    };
    const post = (type: "stdout" | "stderr", data: Uint8Array) => {
      checkActive();
      const fd = type === "stderr" ? 2 : 1;
      if (!wasi) {
        const stream = stdio?.[fd];
        if (stream) return stream.write([data]) === data.length;
        output(type, data);
        return true;
      }
      const descriptor = wasi.descriptors.get(fd);
      if (!descriptor || (descriptor.rightsBase & (1n << 6n)) === 0n) return false;
      const resource = descriptor.resource;
      if (resource.kind === "directory") return false;
      // Like preview1, an empty write neither appends nor moves the shared file cursor.
      if (!data.length) return true;
      if (resource.kind !== "file") return resource.write([data]) === data.length;
      const written = withFileOffset(resource, () => {
        if (resource.append) {
          const result = fs.append(resource.handle, [data]);
          if (typeof result === "number") return result;
          resource.offset = result.offset;
          return result.written;
        }
        const written = fs.write(resource.handle, [data], resource.offset);
        if (written >= 0) resource.offset += written;
        return written;
      });
      return written === data.length;
    };
    const context: WorkerSetupContext<R> = { request: req, fs, isolated, outcome, interrupt, runtimeState, checkActive, defaultSignal, post, finish };
    executor.setup?.(context);
    if (done) return;
    const env = executor.env?.(req) ?? req.env;
    if (done) return;
    const namespaces = executor.namespaces?.(context);
    if (done) return;
    let instance: WebAssembly.Instance;
    const processImports: Record<string, (...args: number[]) => number | void> = {
      signal: (signal, mode) => executor.signal?.(signal!, mode!) ?? -52,
      interrupted: () => req.interruptible ? fatalInterrupt(outcome) : executor.signal?.(0, 0) ?? 0,
      default_signal: signal => {
        try { defaultSignal(signal!); return 0; }
        catch (error) { if (error instanceof ProcessError) return -error.errno; throw error; }
      },
    };
    wasi = new Wasi({
      hostCallFd: executor.hostCallFd,
      args: req.args, env, fs, preopens: { "/": "/" }, stdio,
      stdout: data => { output("stdout", data); }, stderr: data => { output("stderr", data); },
      diagnostic: data => { post("stderr", data); },
      sleep: ms => {
        checkActive();
        if (ms > 0) {
          if (sleepCell) Atomics.wait(sleepCell, 0, 0, ms);
          else { const end = perfNow() + ms; while (perfNow() < end) { /* worker-local spin */ } }
        }
        checkActive();
      },
      interrupt,
      interruptPending: runtimeState ? () => signalPending(runtimeState.signals) : executor.interruptPending ? () => executor.interruptPending!() : undefined,
      wait: (word, expected, ms) => { checkActive(); controlWait(word, 0, expected, ms); checkActive(); },
      namespaces: { ...namespaces, runtime_proc: processImports },
      trace: req.trace ? line => console.debug(`[wasi] ${line}`) : undefined,
    });
    const bindingsContext: WorkerBindingsContext<R> = { ...context, wasi };
    if (req.runtimeProcess) {
      const { createFilesystemDescriptorCodec } = await import("../proc/filesystem-codec.js");
      const { createProcessFilesystemIdentity } = await import("../fs/protocol.js");
      const { WorkerPipeHost } = await import("../proc/worker-pipes.js");
      const { ProcessABI, ProcessSignalExit } = await import("../proc/abi.js");
      const { createRuntimeTerminalCodec } = await import("./runtime-terminals.js");
      processSignalExit = ProcessSignalExit;
      const postMessage = (message: WorkerProcessMessage) => host.postMessage(message);
      const pipes = new WorkerPipeHost({
        transport: req.runtimeProcess, postMessage,
        fallback: createFilesystemDescriptorCodec(fs),
        registry: (req.runtimeProcess.data as { pipeRegistry?: import("../proc/pipes.js").PipePublicationRegistryHandle } | undefined)?.pipeRegistry,
      });
      runtimeProcess = new runtime!.WorkerProcessClient({
        transport: req.runtimeProcess, descriptors: wasi.descriptors,
        // Terminal provenance takes priority even when its resolved stream is a PipeEndpoint.
        codec: createRuntimeTerminalCodec({ fallback: pipes.codec(), descriptors: wasi.descriptors,
          resolveTerminal: executor.resolveTerminal?.bind(executor),
          output: (fd, data) => { output(fd === 2 ? "stderr" : "stdout", data); }, checkActive }), postMessage,
        createPipe: () => { checkActive(); return pipes.createPipe(); },
        revokeProcess: pid => pipes.revokeProcess(pid),
        prepareSpawn: pid => {
          checkActive();
          const end = fs.beginTransfer();
          let filesystem: ReturnType<typeof createProcessFilesystemIdentity> | undefined;
          let enrolled = false;
          const cancel = () => {
            if (filesystem) { revokeFilesystem(filesystem); reapFilesystem(filesystem); }
            if (enrolled) pipes.registry.collectProcess(pid);
          };
          try {
            const data = executor.spawnData?.();
            checkActive();
            pipes.registry.registerProcess(pid);
            enrolled = true;
            filesystem = createProcessFilesystemIdentity(fs.connection);
            return { cancel, data: { ...data, filesystem, pipeRegistry: pipes.registry.handle() }, codec: createRuntimeTerminalCodec({ fallback: pipes.codec(createFilesystemDescriptorCodec(fs, filesystem)) }), release: end };
          } catch (error) {
            try { cancel(); } finally { end(); }
            throw error;
          }
        },
      });
      // Record original default-terminal destinations before the hook moves/closes any fd.
      executor.beforeBindings?.(bindingsContext);
      if (done) return;
      runtimeProcess.installBindings();
      const abi = new ProcessABI({
        memory: () => instance.exports.memory as WebAssembly.Memory,
        descriptors: wasi.descriptors, fs, pid: runtimeProcess.pid, service: runtimeProcess,
        signals: runtimeProcess.signals, wake: runtimeProcess.wake,
        createPipe: () => runtimeProcess!.createPipe(),
        wait: (ms, word, expected) => { checkActive(); controlWait(word, 0, expected, ms); checkActive(); },
      });
      for (const [name, call] of Object.entries(abi.imports)) {
        // Instrumentation never dequeues handled signals or replaces its trap with an ABI unwind.
        if (req.interruptible && name === "interrupted") continue;
        processImports[name] = (...args) => { checkActive(); return call(...args); };
      }
    } else {
      executor.beforeBindings?.(bindingsContext);
      if (done) return;
    }
    const instantiating = perfNow();
    const imports = wasi.imports(req.module);
    // Linking binds WASI views for a real Wasm start section, which runs inside instantiation.
    // Snapshot before a hook can mutate in place; memory replacement cannot preserve those views.
    const memories = executor.imports ? WebAssembly.Module.imports(req.module).filter(entry => entry.kind === "memory")
      .map(entry => ({ ...entry, memory: imports[entry.module]?.[entry.name] })) : undefined;
    const linked = executor.imports?.(imports, bindingsContext) ?? imports;
    if (done) return;
    if (memories?.some(entry => linked[entry.module]?.[entry.name] !== entry.memory)) {
      throw new TypeError("executor imports hook cannot replace imported memory");
    }
    instance = new WebAssembly.Instance(req.module, linked);
    if (typeof instance.exports._start !== "function") throw new ExecutableFormatError("guest has no _start entry point");
    if (!(instance.exports.memory instanceof WebAssembly.Memory)) throw new ExecutableFormatError("guest has no memory");
    host.postMessage({ type: "phase", name: "instantiate", duration: perfNow() - instantiating });
    executor.instantiated?.({ ...context, wasi, instance });
    if (done) return;
    started = true;
    const exited = wasi.launch(instance);
    host.addEventListener?.("error", onError);
    host.addEventListener?.("unhandledrejection", onRejection);
    const completion = executor.run({ ...context, wasi, instance }, exited);
    // Synchronous commands claim their result before guest-scheduled microtasks can run.
    finish({ code: typeof completion === "number" ? completion : await completion });
  } catch (error) {
    finish(terminalResult(error) ?? { error });
  } finally {
    host.removeEventListener?.("error", onError);
    host.removeEventListener?.("unhandledrejection", onRejection);
  }
}

/** Plain preview1 commands have no engine, native slots or module-cache policy. */
export const preview1Executor: WorkerExecutor = { run: (_context, exited) => exited ?? 0 };
