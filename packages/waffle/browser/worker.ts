import { bindImportedMemory, createWorkerMemorySampler } from "./worker-memory.js";
import { NotificationWaitScope } from "./notification-wait.js";
import type { NotificationConnection } from "./notification-relay.js";
import {
  createProcessIdentity,
  type RuntimeHostIdentity,
  type RuntimeProcessIdentity,
} from "./process-context.js";
import { ExecutionUnwind } from "../core/unwind.js";
import { directoryState, isCollectedProcess } from "../proc/directory.js";
import { type ControlCells, controlLoad, controlWait } from "../proc/control.js";
import {
  reviveOutcome,
  type OutcomeTransfer,
  type OutcomeWord,
  claimOutcome,
  outcomeWord,
  processOutcome,
  readOutcome,
  markStarted,
} from "../proc/outcome.js";
// Process bootstrap shared by preview1 commands and injected guest executors.
import { checkedSignal, ProcessError, type ProcessExit } from "../proc/types.js";
import { defaultSignalTerminates, signalPending } from "../proc/signals.js";
import {
  FilesystemClient,
  revokeFilesystem,
  reapFilesystem,
  sharedRevoked,
  type FilesystemConnection,
} from "../fs/index.js";
import { Wasi, WasiExit, type Stream } from "../core/index.js";
import { guardedStream } from "./guarded-stream.js";
import { drainDiagnostic } from "./diagnostic.js";
import { withFileOffset } from "../core/open-file.js";
import type { ProcessABI } from "../proc/abi.js";

import { ExecutableFormatError, startFailure, type StartFailure } from "../proc/start-failure.js";
import { waitStatus } from "../proc/wait-status.js";

import { fatalInterrupt } from "../interrupt/check.js";
import type {
  WorkerProcessClient,
  WorkerProcessMessage,
  WorkerProcessTransport,
  workerProcessState,
} from "../proc/worker-client.js";
import type { PipeEndpointHandle } from "../proc/pipes.js";
import {
  Int32ArrayConstructor,
  SharedArrayBufferConstructor,
  atomicsWait,
  objectEntries,
  reflectApply,
  SetConstructor,
  setHas,
  setAdd,
  arrayAppend,
} from "../proc/intrinsics.ts";

export interface RuntimeWorkerRequest {
  /** Broker-owned latest actual memory sample, never a limit or a real-time guarantee. */
  memoryObservation?: SharedArrayBuffer;
  notifications?: NotificationConnection;
  /** Supplied by the owning page or broker, never read from guest env. */
  hostIdentity?: RuntimeHostIdentity | null;
  module: WebAssembly.Module;
  args: string[];
  env: Record<string, string>;
  filesystem: FilesystemConnection;
  runtimeProcess?: WorkerProcessTransport;
  /** Broker-owned diagnostic lifetime. Close synchronously at entry, not on startup failure. */
  startupStderr?: PipeEndpointHandle;
  /** Authoritative terminal word available before loading process adapters. */
  outcome?: OutcomeTransfer;
  /** Admitted code with fatal-only instrumentation, not an admission bypass. */
  interruptible?: boolean;
  trace?: boolean;
}

export type SleepMode = "atomics" | "busy-wait";
export type RuntimeWorkerMessage =
  | WorkerProcessMessage
  | { type: "phase"; name: string; duration: number }
  | { type: "stdout" | "stderr"; data: Uint8Array }
  | { type: "exit"; code: number; signal?: number; sleep?: SleepMode; cleanupErrors?: string[] }
  | {
      type: "error";
      code: number;
      errno?: StartFailure;
      message: string;
      sleep?: SleepMode;
      cleanupErrors?: string[];
    }
  /** Owned-resource release failed: diagnostic only, never a quiescence acknowledgement. */
  | {
      type: "cleanup-error";
      code: number;
      signal?: number;
      message: string;
      cleanupErrors: string[];
      sleep?: SleepMode;
    }
  | { type: "default-signal"; signal: number };

export interface RuntimeWorkerHost {
  readonly crossOriginIsolated: boolean;
  postMessage(message: RuntimeWorkerMessage, transfer?: Transferable[]): void;
  addEventListener?(
    type: "error" | "unhandledrejection",
    listener: (event: WorkerTerminalEvent) => void,
  ): void;
  removeEventListener?(
    type: "error" | "unhandledrejection",
    listener: (event: WorkerTerminalEvent) => void,
  ): void;
}
interface WorkerTerminalEvent {
  error?: unknown;
  reason?: unknown;
  preventDefault(): void;
}
export type WorkerResult = { code: number; signal?: number } | { error: unknown };
export type RuntimeWorkerState = ReturnType<typeof workerProcessState>;

export interface WorkerSetupContext<R extends RuntimeWorkerRequest = RuntimeWorkerRequest> {
  request: R;
  readonly notifications?: NotificationWaitScope;
  readonly signal: AbortSignal;
  fs: FilesystemClient;
  isolated: boolean;
  outcome: OutcomeWord | null;
  interrupt?: ControlCells;
  runtimeState: RuntimeWorkerState | null;
  identity: RuntimeProcessIdentity | null;
  checkActive(): void;
  defaultSignal(signal: number): void;
  post(type: "stdout" | "stderr", data: Uint8Array): boolean;
  finish(result: WorkerResult): void;
}
export interface WorkerBindingsContext<
  R extends RuntimeWorkerRequest = RuntimeWorkerRequest,
> extends WorkerSetupContext<R> {
  wasi: Wasi;
}
export interface WorkerExecutionContext<
  R extends RuntimeWorkerRequest = RuntimeWorkerRequest,
> extends WorkerBindingsContext<R> {
  instance: WebAssembly.Instance;
  process?: ProcessABI;
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
  /** Runs after default stdio/preopen creation, before inherited descriptor binding. */
  beforeBindings?(context: WorkerBindingsContext<R>): void;
  /** Mutate or replace the linked import object, after bindings and before instantiation. */
  imports?(
    imports: WebAssembly.Imports,
    context: WorkerBindingsContext<R>,
  ): WebAssembly.Imports | void;
  /** Compose one process-local instance group; late work must call checkActive before publication. */
  instantiate?(
    imports: WebAssembly.Imports,
    context: WorkerBindingsContext<R> & { bindMemory(memory: WebAssembly.Memory): void },
  ): WebAssembly.Instance | Promise<WebAssembly.Instance>;
  initialize?(context: WorkerExecutionContext<R>): void;
  /** Structured-cloneable child metadata; filesystem and pipeRegistry are reserved. */
  spawnData?(): Record<string, unknown>;
  /** Resolve inherited terminal provenance; undefined keeps default EOF input or host output. */
  resolveTerminal?(target: 0 | 1 | 2): Stream | undefined;
  signal?(signal: number, mode: number): number;
  signalError?(signal: number): never;
  terminalSignal?(error: unknown): number | undefined;
  beforeFinish?(): void;
  diagnostic?(message: string): void;
  /** Runs after descriptors/filesystem have been released, before the exit acknowledgement. */
  complete?(code: number, signal?: number): ProcessExit;
  instantiated?(context: WorkerExecutionContext<R>): void | Promise<void>;
  run(context: WorkerExecutionContext<R>, exited: number | null): number | Promise<number>;
}

export class RuntimeWorkerSignal extends ExecutionUnwind {
  constructor(readonly signal: number) {
    super(`Process stopped by signal ${signal}`);
  }
}

// Keep the native clock before an executor can install guest-side globals.
const perfNow = performance.now.bind(performance);
// The default Worker host is guest-visible. Capture its native hooks at module load;
// explicit embedding hosts supply trusted callbacks, captured once at bootstrap entry.
const defaultPostMessage = globalThis.postMessage;
const defaultAddEventListener = globalThis.addEventListener;
const defaultRemoveEventListener = globalThis.removeEventListener;

/** `Name: message` plus the first stack frames. */
export function describeWorkerError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const head = `${err.name}: ${err.message}`;
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((line) => line.trim() && !line.includes(err.message))
    .slice(0, 15);
  return frames.length
    ? `${head}\n${frames.map((frame) => `    ${frame.trim()}`).join("\n")}`
    : head;
}

function createSleepCell(host: RuntimeWorkerHost): Int32Array | null {
  if (!host.crossOriginIsolated || typeof SharedArrayBufferConstructor !== "function") return null;
  return new Int32ArrayConstructor(new SharedArrayBufferConstructor(4));
}

function captureWorkerHost(host: RuntimeWorkerHost) {
  const postMethod = host === globalThis ? defaultPostMessage : host.postMessage;
  const addListener = host === globalThis ? defaultAddEventListener : host.addEventListener;
  const removeListener =
    host === globalThis ? defaultRemoveEventListener : host.removeEventListener;
  const postToHost = (message: RuntimeWorkerMessage, transfer?: Transferable[]) => {
    reflectApply(postMethod, host, transfer ? [message, transfer] : [message]);
  };
  return { postToHost, addListener, removeListener };
}

function residentPreopens(filesystem: FilesystemConnection): Record<string, string> {
  return filesystem.residentPublication?.kind === "file" ? {} : { "/": "/" };
}

function startupControl(connection: NotificationConnection | undefined, fs: FilesystemClient) {
  const cancellation = new AbortController();
  const notifications = connection ? new NotificationWaitScope(connection, fs) : undefined;
  let cancelStartup!: () => void;
  const startupCancelled = new Promise<void>((resolve) => {
    cancelStartup = resolve;
  });
  void notifications?.closed.then(() => {
    cancellation.abort();
    cancelStartup();
  });
  return { cancellation, notifications, startupCancelled, cancelStartup };
}

/**
 * The modules a runtime process needs, all requested at once: awaiting them one by one costs a
 * fetch round trip each. Each group is still awaited where it is first used, so a failure keeps
 * its original place in startup, and never surfaces as an unhandled rejection in the meantime.
 */
function loadProcessModules(runtimeProcess: unknown) {
  if (!runtimeProcess) return null;
  const client = import("../proc/worker-client.js");
  const host = Promise.all([
    import("../proc/filesystem-codec.js"),
    import("../fs/protocol.js"),
    import("../proc/worker-pipes.js"),
    import("../proc/abi.js"),
    import("./runtime-terminals.js"),
  ]);
  client.catch(() => {});
  host.catch(() => {});
  return { client, host };
}

function ownedStreams(stdio: WorkerExecutor["stdio"]): Stream[] {
  const streams = [stdio?.[0], stdio?.[1], stdio?.[2]];
  const owned: Stream[] = [];
  for (let index = 0; index < streams.length; index++) {
    const stream = streams[index];
    if (stream) arrayAppend(owned, stream);
  }
  return owned;
}

function initialStdio(
  runtimeState: RuntimeWorkerState | null,
  ownedStdio: Partial<Record<0 | 1 | 2, Stream>> | undefined,
  checkIoActive: () => void,
): {
  stdio: Partial<Record<0 | 1 | 2, Stream | null>> | undefined;
  discarded: Stream[];
} {
  if (runtimeState && runtimeState.parentPid !== 0)
    return {
      stdio: { 0: null, 1: null, 2: null },
      discarded: ownedStreams(ownedStdio),
    };
  if (!ownedStdio) return { stdio: undefined, discarded: [] };
  return {
    stdio: {
      ...(ownedStdio[0] ? { 0: guardedStream(ownedStdio[0], checkIoActive) } : {}),
      ...(ownedStdio[1] ? { 1: guardedStream(ownedStdio[1], checkIoActive) } : {}),
      ...(ownedStdio[2] ? { 2: guardedStream(ownedStdio[2], checkIoActive) } : {}),
    },
    discarded: [],
  };
}

function tableOwnedStdio(
  descriptors: Wasi["descriptors"],
  discarded: readonly Stream[],
): Set<Stream> {
  const tableOwned = new SetConstructor<Stream>();
  for (let index = 0; index < discarded.length; index++) {
    const stream = discarded[index]!;
    if (descriptors.hasResource(stream)) setAdd(tableOwned, stream);
  }
  return tableOwned;
}

function closeDiscardedStdio(discarded: readonly Stream[], tableOwned: ReadonlySet<Stream>): void {
  const closed = new SetConstructor<Stream>();
  const errors: unknown[] = [];
  for (let index = 0; index < discarded.length; index++) {
    const stream = discarded[index]!;
    if (setHas(tableOwned, stream) || setHas(closed, stream)) continue;
    setAdd(closed, stream);
    try {
      stream.close?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "stdio release failed");
}

function disposeProcessDescriptors(wasi: Wasi, discarded: readonly Stream[]): void {
  const tableOwned = tableOwnedStdio(wasi.descriptors, discarded);
  const errors: unknown[] = [];
  try {
    wasi.descriptors.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    closeDiscardedStdio(discarded, tableOwned);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "descriptor release failed");
}

function transferStdio(stream: Stream | undefined, discarded: Stream[]): Stream | undefined {
  if (stream === undefined) return;
  for (let index = discarded.length - 1; index >= 0; index--) {
    if (discarded[index] !== stream) continue;
    discarded[index] = discarded[discarded.length - 1]!;
    discarded.length--;
  }
  return stream;
}

function adoptStdio(descriptors: Wasi["descriptors"], discarded: Stream[]): void {
  for (let index = discarded.length - 1; index >= 0; index--) {
    const stream = discarded[index]!;
    if (descriptors.hasResource(stream)) transferStdio(stream, discarded);
  }
}

/** Instantiate one process using explicit capabilities; never creates a page runtime. */
export async function bootstrap<R extends RuntimeWorkerRequest>(
  req: R,
  executor: WorkerExecutor<R>,
  host: RuntimeWorkerHost = globalThis as unknown as RuntimeWorkerHost,
): Promise<void> {
  const { postToHost, addListener, removeListener } = captureWorkerHost(host);
  postToHost({ type: "phase", name: "worker-start", duration: 0 });
  const fs = new FilesystemClient(req.filesystem);
  const { cancellation, notifications, startupCancelled, cancelStartup } = startupControl(
    req.notifications,
    fs,
  );
  let runtimeProcess: WorkerProcessClient | null = null;
  let process: ProcessABI | undefined;
  let processSignalExit: typeof import("../proc/abi.js").ProcessSignalExit | undefined;
  let discardedStdio: Stream[] = [];
  const sleepCell = createSleepCell(host);
  const isolated = sleepCell !== null;
  const sleepMode: SleepMode = sleepCell ? "atomics" : "busy-wait";
  // A delayed physical Worker can start after its process incarnation was collected.
  // Acquire shared authority inside the cleanup boundary, not after opening fs but before try.
  let outcome: OutcomeWord | null = null;
  let diagnosticWrite = false;
  let requestedSignal: ControlCells | undefined = executor.requestedSignal
    ? new Int32ArrayConstructor(executor.requestedSignal)
    : undefined;
  const revoked = sharedRevoked(req.filesystem);
  let localOutcome: ProcessExit | null = null;
  const detachCollectedProcess = (error: unknown): void => {
    if (!isCollectedProcess(error)) throw error;
    // Shared authority can disappear during asynchronous adapter loading, too. Only local
    // cleanup/reporting remains valid; never send an exit for the slot's new incarnation.
    outcome = null;
    runtimeProcess = null;
    requestedSignal = undefined;
  };
  const claim = (result: Pick<ProcessExit, "kind" | "code">): ProcessExit => {
    try {
      if (outcome) return claimOutcome(outcome, result);
    } catch (error) {
      detachCollectedProcess(error);
    }
    return (localOutcome ??= processOutcome(result));
  };
  const defaultSignal = (signal: number): void => {
    checkedSignal(signal);
    const killed = requestedSignal && controlLoad(requestedSignal, 0) === 9;
    if (
      !(outcome ? readOutcome(outcome) : localOutcome) &&
      !killed &&
      !defaultSignalTerminates(signal)
    )
      return;
    const winner = claim({ kind: "signaled", code: killed ? 9 : signal });
    if (winner.kind !== "signaled") throw new WasiExit(waitStatus(winner));
    runtimeProcess?.defaultSignal(runtimeProcess.pid, winner.code);
    revokeFilesystem(fs.connection);
    // Logical death is not an acknowledgement that filesystem references were released.
    if (!outcome && winner.kind === "signaled")
      postToHost({ type: "default-signal", signal: winner.code });
    if (executor.signalError) return executor.signalError(winner.code);
    throw new RuntimeWorkerSignal(winner.code);
  };
  const checkActive = () => {
    const winner = outcome ? readOutcome(outcome) : localOutcome;
    if (winner?.kind === "signaled") defaultSignal(winner.code);
    if (winner) throw new WasiExit(waitStatus(winner));
    if (revoked() || cancellation.signal.aborted) throw new WasiExit(1);
  };
  // Only the synchronous host-authored diagnostic write may use still-owned I/O after its
  // terminal claim. Guest calls remain guarded, and revocation still retires that authority.
  const checkIoActive = () => {
    if (!diagnosticWrite) {
      checkActive();
      return;
    }
    if (revoked()) throw new WasiExit(1);
  };
  // Ownership begins before setup/namespaces can fail or finish the process.
  const ownedStdio = executor.stdio ? { ...executor.stdio } : undefined;
  let wasi: Wasi | null = null;
  let memorySampler: ReturnType<typeof createWorkerMemorySampler> | undefined;
  let releaseStartupStderr: (() => void) | undefined;
  let done = false;
  let started = false;
  let writeDiagnostic: ((data: Uint8Array) => number) | undefined;
  let pendingFinish: Promise<void> | undefined;
  const finish = (result: WorkerResult): void => {
    if (done) return;
    done = true;
    cancellation.abort();
    cancelStartup();
    pendingFinish = finishOwned(result);
  };
  const finishOwned = async (result: WorkerResult): Promise<void> => {
    let settled = localOutcome;
    try {
      if (outcome) settled = readOutcome(outcome);
    } catch (error) {
      detachCollectedProcess(error);
    }
    const ownCode = "code" in result ? result.code : started ? 1 : 126;
    const ownSignal = "signal" in result ? result.signal : undefined;
    const startupFailure = "error" in result && !started;
    const ownResult: Pick<ProcessExit, "kind" | "code"> = startupFailure
      ? startFailure(result.error)
      : ownSignal === undefined
        ? { kind: "exited", code: ownCode }
        : { kind: "signaled", code: ownSignal };
    // Claim the runtime outcome before draining so a signal delivered during backpressure
    // cannot replace the original execution failure.
    const runtimeDiagnostic = !executor.complete && started && "error" in result && !settled;
    let winner =
      runtimeDiagnostic || !executor.complete || startupFailure ? claim(ownResult) : settled;
    const cleanupErrors: string[] = [];
    const collect = (error: unknown): void => {
      if (error instanceof AggregateError && error.errors.length)
        for (const cause of error.errors) collect(cause);
      else cleanupErrors.push(describeWorkerError(error));
    };
    const attempt = (cleanup: () => void): boolean => {
      try {
        cleanup();
        return true;
      } catch (error) {
        collect(error);
        return false;
      }
    };
    attempt(() => notifications?.dispose());
    if (runtimeDiagnostic && "error" in result) {
      try {
        const bytes = new TextEncoder().encode(`${describeWorkerError(result.error)}\n`);
        const pending = drainDiagnostic(bytes, (data) => writeDiagnostic!(data));
        if (pending) await pending;
      } catch (error) {
        collect(error);
      }
      winner = claim(ownResult);
    }
    if (winner?.kind !== "start-failed") attempt(() => releaseStartupStderr?.());
    attempt(() => executor.beforeFinish?.());
    attempt(() => memorySampler?.sample());
    // Legacy transports must buffer diagnostics before publishing logical completion.
    if (
      executor.complete &&
      "error" in result &&
      (startupFailure ? !req.runtimeProcess && winner?.kind === "start-failed" : !settled)
    ) {
      attempt(() => executor.diagnostic?.(`${describeWorkerError(result.error)}\n`));
    }
    const descriptorsReleased = attempt(() => {
      if (wasi) {
        disposeProcessDescriptors(wasi, discardedStdio);
        return;
      }
      const streams = ownedStreams(ownedStdio);
      closeDiscardedStdio(streams, new SetConstructor());
    });
    let filesystemReleased = attempt(() => fs.dispose());
    if (req.filesystem.residentPublication && descriptorsReleased && filesystemReleased) {
      try {
        await fs.stopResidentPublication();
      } catch (error) {
        collect(error);
        filesystemReleased = false;
      }
    }
    if (!descriptorsReleased || !filesystemReleased) {
      // A failed local release cannot certify quiescence. Leave completion unpublished so
      // the page must fence this process before termination or releasing inherited refs.
      winner ??= claim(ownResult);
      postToHost({
        type: "cleanup-error",
        code: waitStatus(winner),
        signal: winner.kind === "signaled" ? winner.code : undefined,
        message: cleanupErrors.join("\n"),
        cleanupErrors,
        sleep: sleepMode,
      });
      return;
    }
    if (executor.complete)
      attempt(() => {
        winner = executor.complete!(ownCode, ownSignal);
      });
    winner ??= claim(ownResult);
    const code = waitStatus(winner);
    const signal = winner.kind === "signaled" ? winner.code : undefined;
    if (!executor.complete) attempt(() => runtimeProcess?.exit(code));
    const diagnostics = cleanupErrors.length ? { cleanupErrors } : {};
    if (
      (executor.complete || "code" in result || settled || winner.kind === "signaled") &&
      !(req.runtimeProcess && startupFailure && winner.kind === "start-failed")
    ) {
      postToHost({ type: "exit", code, signal, sleep: sleepMode, ...diagnostics });
    } else {
      postToHost({
        type: "error",
        code,
        errno: winner.kind === "start-failed" ? winner.error : undefined,
        message: describeWorkerError(result.error),
        sleep: sleepMode,
        ...diagnostics,
      });
    }
  };
  const terminalResult = (error: unknown): { code: number; signal?: number } | null => {
    if (error instanceof WasiExit) return { code: error.code };
    const signal =
      error instanceof RuntimeWorkerSignal ||
      (processSignalExit && error instanceof processSignalExit)
        ? error.signal
        : executor.terminalSignal?.(error);
    return signal === undefined ? null : { code: 128 + signal, signal };
  };
  const onError = (event: WorkerTerminalEvent) => {
    const result = terminalResult(event.error);
    if (result) {
      event.preventDefault();
      finish(result);
    }
  };
  const onRejection = (event: WorkerTerminalEvent) => {
    const result = terminalResult(event.reason);
    if (result) {
      event.preventDefault();
      finish(result);
    }
  };
  try {
    // A valid process must publish even its first adapter-import failure to shared state.
    // Keep this synchronous, while still routing a stale incarnation through finish().
    const requestOutcome = req.outcome === undefined ? undefined : reviveOutcome(req.outcome);
    const sharedOutcome = req.runtimeProcess
      ? directoryState(req.runtimeProcess).signals.outcome
      : (requestOutcome ?? executor.outcome);
    outcome = sharedOutcome || isolated ? outcomeWord(sharedOutcome) : null;
    if (req.memoryObservation) memorySampler = createWorkerMemorySampler(req.memoryObservation);
    const processModules = loadProcessModules(req.runtimeProcess);
    if (req.filesystem.residentPublication) await fs.attachResidentPublication();
    if (req.startupStderr) {
      const { attachPipeEndpoint } = await import("../proc/pipes.js");
      const endpoint = attachPipeEndpoint(req.startupStderr);
      releaseStartupStderr = () => endpoint.close();
    }
    const runtime = processModules ? await processModules.client : null;
    const runtimeState = req.runtimeProcess
      ? runtime!.workerProcessState(req.runtimeProcess)
      : null;
    if (
      !runtimeState &&
      (executor.interrupt || executor.requestedSignal || executor.signal) &&
      typeof executor.interruptPending !== "function"
    ) {
      throw new TypeError(
        "WorkerExecutor.interruptPending is required for executor-owned signal transports",
      );
    }
    const interrupt =
      runtimeState?.signals.interrupt ??
      (executor.interrupt ? new Int32ArrayConstructor(executor.interrupt) : undefined);
    if (runtimeState) {
      outcome = runtimeState.signals.outcome;
      requestedSignal = runtimeState.signals.requestedSignal;
    }
    const initial = initialStdio(runtimeState, ownedStdio, checkIoActive);
    const stdio = initial.stdio;
    discardedStdio = initial.discarded;
    // Default terminal descriptions must post directly: routing their callbacks back through
    // the live fd would recurse, or send an inherited terminal into a redirected file.
    const output = (type: "stdout" | "stderr", data: Uint8Array) => {
      checkIoActive();
      postToHost({ type, data }, [data.buffer as ArrayBuffer]);
    };
    const write = (type: "stdout" | "stderr", data: Uint8Array, immediate = false): number => {
      if (immediate) checkIoActive();
      else checkActive();
      const fd = type === "stderr" ? 2 : 1;
      if (!wasi) {
        const stream = stdio?.[fd];
        if (stream) return immediate ? (stream.tryWrite?.([data]) ?? -58) : stream.write([data]);
        output(type, data);
        return data.length;
      }
      const descriptor = wasi.descriptors.get(fd);
      if (!descriptor || (descriptor.rightsBase & (1n << 6n)) === 0n) return -8;
      const resource = descriptor.resource;
      if (resource.kind === "directory") return -31;
      // Like preview1, an empty write neither appends nor moves the shared file cursor.
      if (!data.length) return 0;
      if (resource.kind !== "file")
        return immediate ? (resource.tryWrite?.([data]) ?? -58) : resource.write([data]);
      if (immediate) {
        return withFileOffset(
          resource,
          () => {
            if (resource.append) {
              const result = fs.tryAppend(resource.handle, [data]);
              if (typeof result === "number") return result;
              resource.offset = result.offset;
              return result.written;
            }
            const written = fs.tryWrite(resource.handle, [data], resource.offset);
            if (written >= 0) resource.offset += written;
            return written;
          },
          true,
        );
      }
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
      return written;
    };
    writeDiagnostic = (data) => {
      diagnosticWrite = true;
      try {
        return write("stderr", data, true);
      } finally {
        diagnosticWrite = false;
      }
    };
    const post = (type: "stdout" | "stderr", data: Uint8Array) => write(type, data) === data.length;
    const identity = createProcessIdentity(runtimeState, req.hostIdentity);
    const context: WorkerSetupContext<R> = {
      identity,
      request: req,
      notifications,
      signal: cancellation.signal,
      fs,
      isolated,
      outcome,
      interrupt,
      runtimeState,
      checkActive,
      defaultSignal,
      post,
      finish,
    };
    executor.setup?.(context);
    if (done) return;
    const env = executor.env?.(req) ?? req.env;
    if (done) return;
    const namespaces = executor.namespaces?.(context);
    if (done) return;
    // Launch descriptors, snapshotted after bindings and before the guest can open its own.
    let inherited: readonly number[] = [];
    const processImports: Record<string, (...args: number[]) => number | void> = {
      fd_reopen: (
        fd: number,
        oflags: number,
        fdflags: number,
        base: number | bigint,
        out: number,
      ) => {
        checkActive();
        return wasi!.fdReopen(fd, oflags, fdflags, BigInt(base), out);
      },
      fd_kind: (fd) => {
        checkActive();
        return wasi!.descriptors.kind(fd! >>> 0);
      },
      inherited_fd: (index) => {
        checkActive();
        return inherited[index! >>> 0] ?? -44; // WASI ENOENT ends the list
      },
      signal: (signal, mode) => executor.signal?.(signal!, mode!) ?? -52,
      // Guest-owned runtime_proc.interrupted remains the cooperative handled-signal probe.
      // Instrumented source checkpoints use the private fatal import below so a pre-existing
      // interrupted import is never rebound to immutable supervisor-outcome semantics.
      interrupted: () => executor.signal?.(0, 0) ?? 0,
      __waffle_fatal: () => fatalInterrupt(outcome),
      default_signal: (signal) => {
        try {
          defaultSignal(signal!);
          return 0;
        } catch (error) {
          if (error instanceof ProcessError) return -error.errno;
          throw error;
        }
      },
    };
    let reservedFds: number[] | undefined;
    if (req.runtimeProcess) {
      reservedFds = [];
      for (let index = 0; index < req.runtimeProcess.bindings.length; index++) {
        reservedFds[index] = req.runtimeProcess.bindings[index]!.fd;
      }
    }
    wasi = new Wasi({
      hostCallFd: executor.hostCallFd,
      args: req.args,
      env,
      fs,
      preopens: residentPreopens(req.filesystem),
      reservedFds,
      stdio,
      stdout: (data) => {
        output("stdout", data);
      },
      stderr: (data) => {
        output("stderr", data);
      },
      diagnostic: (data) => {
        post("stderr", data);
      },
      sleep: (ms) => {
        checkActive();
        if (ms > 0) {
          if (sleepCell) atomicsWait(sleepCell, 0, 0, ms);
          else {
            const end = perfNow() + ms;
            while (perfNow() < end) {
              /* worker-local spin */
            }
          }
        }
        checkActive();
      },
      interrupt,
      interruptPending: runtimeState
        ? () => signalPending(runtimeState.signals)
        : executor.interruptPending
          ? () => executor.interruptPending!()
          : undefined,
      wait: (word, expected, ms) => {
        checkActive();
        controlWait(word, 0, expected, ms);
        checkActive();
      },
      namespaces: { ...namespaces, runtime_proc: processImports },
      trace: req.trace ? (line) => console.debug(`[wasi] ${line}`) : undefined,
    });
    let boundMemory: WebAssembly.Memory | undefined;
    const bindMemory = (memory: WebAssembly.Memory) => {
      checkActive();
      if (boundMemory && boundMemory !== memory)
        throw new ExecutableFormatError("executor cannot replace bound process memory");
      wasi!.bindMemory(memory);
      boundMemory = memory;
      memorySampler?.bind(memory);
    };
    const bindingsContext: WorkerBindingsContext<R> = { ...context, wasi };
    if (req.runtimeProcess) {
      const [
        { createFilesystemDescriptorCodec },
        { createProcessFilesystemIdentity },
        { WorkerPipeHost },
        { ProcessABI, ProcessSignalExit },
        { createRuntimeTerminalCodec },
      ] = await processModules!.host;
      processSignalExit = ProcessSignalExit;
      const postMessage = (message: WorkerProcessMessage) => postToHost(message);
      const pipes = new WorkerPipeHost({
        transport: req.runtimeProcess,
        postMessage,
        fallback: createFilesystemDescriptorCodec(fs),
        registry: (
          req.runtimeProcess.data as
            | { pipeRegistry?: import("../proc/pipes.js").PipePublicationRegistryHandle }
            | undefined
        )?.pipeRegistry,
      });
      runtimeProcess = new runtime!.WorkerProcessClient({
        transport: req.runtimeProcess,
        descriptors: wasi.descriptors,
        // Terminal provenance takes priority even when its resolved stream is a PipeEndpoint.
        codec: createRuntimeTerminalCodec({
          fallback: pipes.codec(),
          descriptors: wasi.descriptors,
          resolveTerminal: executor.resolveTerminal
            ? (...args) => transferStdio(executor.resolveTerminal!(...args), discardedStdio)
            : undefined,
          output: (fd, data) => {
            output(fd === 2 ? "stderr" : "stdout", data);
          },
          checkActive: checkIoActive,
        }),
        postMessage,
        createPipe: () => {
          checkActive();
          return pipes.createPipe();
        },
        revokeProcess: (pid) => pipes.revokeProcess(pid),
        prepareSpawn: (pid) => {
          checkActive();
          const end = fs.beginTransfer();
          let filesystem: ReturnType<typeof createProcessFilesystemIdentity> | undefined;
          let enrolled = false;
          const cancel = () => {
            if (filesystem) {
              revokeFilesystem(filesystem);
              reapFilesystem(filesystem);
            }
            if (enrolled) pipes.registry.collectProcess(pid);
          };
          try {
            const data = executor.spawnData?.();
            checkActive();
            pipes.registry.registerProcess(pid);
            enrolled = true;
            filesystem = createProcessFilesystemIdentity(fs.connection);
            return {
              cancel,
              data: { ...data, filesystem, pipeRegistry: pipes.registry.handle() },
              codec: createRuntimeTerminalCodec({
                fallback: pipes.codec(createFilesystemDescriptorCodec(fs, filesystem)),
              }),
              release: end,
            };
          } catch (error) {
            try {
              cancel();
            } finally {
              end();
            }
            throw error;
          }
        },
      });
      // Record original default-terminal destinations before the hook moves/closes any fd.
      executor.beforeBindings?.(bindingsContext);
      if (done) return;
      adoptStdio(wasi.descriptors, discardedStdio);
      runtimeProcess.installBindings();
      process = new ProcessABI({
        memory: () => {
          checkActive();
          if (!boundMemory) throw new ExecutableFormatError("process memory is not bound");
          return boundMemory;
        },
        descriptors: wasi.descriptors,
        fs,
        pid: runtimeProcess.pid,
        service: runtimeProcess,
        signals: runtimeProcess.signals,
        wake: runtimeProcess.wake,
        createPipe: () => runtimeProcess!.createPipe(),
        wait: (ms, word, expected) => {
          checkActive();
          controlWait(word, 0, expected, ms);
          checkActive();
        },
      });
      const entries = objectEntries(process.imports);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!,
          name = entry[0],
          call = entry[1];
        processImports[name] = (...args) => {
          checkActive();
          return call(...args);
        };
      }
    } else {
      executor.beforeBindings?.(bindingsContext);
      if (done) return;
    }
    inherited = wasi.descriptors.inheritable();
    const instantiating = perfNow();
    const imports = wasi.imports(req.module);
    // Linking binds WASI views for a real Wasm start section, which runs inside instantiation.
    // Snapshot before a hook can mutate in place; memory replacement cannot preserve those views.
    const memories = executor.imports
      ? WebAssembly.Module.imports(req.module)
          .filter((entry) => entry.kind === "memory")
          .map((entry) => ({ ...entry, memory: imports[entry.module]?.[entry.name] }))
      : undefined;
    const linked = executor.imports?.(imports, bindingsContext) ?? imports;
    if (done) return;
    if (memories?.some((entry) => linked[entry.module]?.[entry.name] !== entry.memory)) {
      throw new TypeError("executor imports hook cannot replace imported memory");
    }
    bindImportedMemory(req.module, linked, bindMemory);
    const sampled = memorySampler?.imports(req.module, linked) ?? linked;
    const instance = executor.instantiate
      ? await Promise.race([
          executor.instantiate(sampled, { ...bindingsContext, bindMemory }),
          startupCancelled.then(() => {
            checkActive();
            throw new Error("startup cancelled");
          }),
        ])
      : new WebAssembly.Instance(req.module, sampled);
    if (done) return;
    checkActive();
    if (!(instance.exports.memory instanceof WebAssembly.Memory))
      throw new ExecutableFormatError("guest has no memory");
    bindMemory(instance.exports.memory);
    if (typeof instance.exports._start !== "function")
      throw new ExecutableFormatError("guest has no _start entry point");
    postToHost({ type: "phase", name: "instantiate", duration: perfNow() - instantiating });
    const executionContext: WorkerExecutionContext<R> = { ...context, wasi, instance, process };
    await Promise.race([executor.instantiated?.(executionContext), startupCancelled]);
    if (done) return;
    checkActive();
    executor.initialize?.(executionContext);
    if (done) return;
    checkActive();
    const exited = wasi.launch(instance, () => {
      checkActive();
      const committed = runtimeProcess
        ? runtimeProcess.started()
        : outcome
          ? markStarted(outcome)
          : true;
      if (!committed) checkActive();
      releaseStartupStderr?.();
      started = true;
    });
    if (addListener) reflectApply(addListener, host, ["error", onError]);
    if (addListener) reflectApply(addListener, host, ["unhandledrejection", onRejection]);
    const completion = executor.run(executionContext, exited);
    // Synchronous commands claim their result before guest-scheduled microtasks can run.
    finish({ code: typeof completion === "number" ? completion : await completion });
  } catch (error) {
    finish(terminalResult(error) ?? { error });
  } finally {
    try {
      await pendingFinish;
    } finally {
      if (removeListener) reflectApply(removeListener, host, ["error", onError]);
      if (removeListener) reflectApply(removeListener, host, ["unhandledrejection", onRejection]);
    }
  }
}

/** Plain preview1 commands have no engine, native slots or module-cache policy. */
export const preview1Executor: WorkerExecutor = { run: (_context, exited) => exited ?? 0 };
