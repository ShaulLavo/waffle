import type { StartFailure } from "./start-errno.ts";
import type { ControlCells } from "./control.js";
import type { OutcomeWord } from "./outcome.js";
import type { DescriptorTable } from "../core/descriptors.js";

export const Signal = Object.freeze({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPWR: 30,
  SIGSYS: 31,
  SIGRTMIN: 34,
  SIGRTMAX: 64,
});
export type ProcessSignal = number;
export type Signal = ProcessSignal;
export type ProcessExit = Readonly<
  | { kind: "exited" | "signaled"; code: number; status: number }
  | { kind: "start-failed"; code: number; error: StartFailure; status: null }
>;
export interface DescriptorBinding {
  child: number;
  parent: number;
}
export interface SpawnRequest {
  executable: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** 0 creates a foreground job, -1 a background job; positive ids join a job. */
  job: number;
  fds: DescriptorBinding[];
}
/** Immutable shared-directory job identity, independent of controller message order. */
export interface SharedJobIdentity {
  readonly ownerPid: number;
  readonly controlParent?: number;
  readonly leaderPid: number;
  readonly outcome: OutcomeWord;
  readonly foreground: boolean;
}
export interface SpawnReservation {
  controlParent?: number;
  rootPid?: number;
  pid?: number;
  job?: number;
  interrupt?: ControlCells | SharedArrayBuffer;
  requestedSignal?: ControlCells | SharedArrayBuffer;
  signalState?: ControlCells | SharedArrayBuffer;
  outcome?: OutcomeWord | SharedArrayBuffer;
}
export interface ProcessHandle {
  /** Physical teardown only: revoked shared buffers are never reused, even after this returns. */
  terminate(): void | Promise<void>;
}
export interface ProcessContext {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  readonly request: Readonly<SpawnRequest>;
  readonly module: WebAssembly.Module;
  readonly adapter: string;
  /** This admitted module has injected interruption imports, rather than cooperative guest checkpoints. */
  readonly interruptible: boolean;
  readonly descriptors: DescriptorTable;
  /** Wake hint only; signal identity and pending delivery live in signalState. */
  readonly interrupt: ControlCells;
  /** Unlike interrupt, this word preserves the last requested signal after a checkpoint. */
  readonly requestedSignal: ControlCells;
  /** Shared per-signal disposition and pending cells, indexed by signal number. */
  readonly signalState: ControlCells;
  /** Shared immutable terminal outcome, atomically arbitrated with synchronous parent stubs. */
  readonly outcome: OutcomeWord;
  /** Commit executable entry after setup; false means a terminal winner prevented entry. */
  started(): boolean;
  exit(code: number): void;
  /** Execution failures after startup retain ordinary exit status 126. */
  fail(error: unknown): void;
  startFailed(error: unknown): void;
  defaultSignal(signal?: number): void;
  registerRevocation(hook: () => void): () => void;
}
export interface ChildExitEvent {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  readonly result: ProcessExit;
}
export class ProcessError extends Error {
  readonly errno: number;
  constructor(errno: number, message: string) {
    super(message);
    this.errno = errno;
    this.name = "ProcessError";
  }
}
export const ProcessErrno = Object.freeze({
  AGAIN: 6,
  BADF: 8,
  CANCELED: 11,
  CHILD: 12,
  INVAL: 28,
  NOTSUP: 58,
  SRCH: 71,
});
export function checkedSignal(signal: number): ProcessSignal {
  if (!Number.isInteger(signal) || signal < 1 || signal > 64 || signal === 32 || signal === 33) {
    throw new ProcessError(ProcessErrno.INVAL, `invalid signal ${signal}`);
  }
  if (signal >= Signal.SIGSTOP && signal <= Signal.SIGTTOU) {
    throw new ProcessError(ProcessErrno.NOTSUP, `stop signal ${signal} is not supported`);
  }
  return signal;
}
