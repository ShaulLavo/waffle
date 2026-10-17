import type { ControlCells } from "./control.js";
import type { OutcomeWord } from "./outcome.js";
import type { DescriptorTable } from "../core/descriptors.js";

export const Signal = Object.freeze({ SIGINT: 2, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 });
export type ProcessSignal = 2 | 9 | 13 | 15;
export type Signal = ProcessSignal;
export type ProcessExit = Readonly<
  | { kind: "exited" | "signaled"; code: number; status: number }
  | { kind: "start-failed"; code: number; error: "ENOENT" | "EACCES"; status: null }
>;
export interface DescriptorBinding { child: number; parent: number }
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
  constructor(errno: number, message: string) { super(message); this.errno = errno; this.name = "ProcessError"; }
}
export const ProcessErrno = Object.freeze({ AGAIN: 6, BADF: 8, CHILD: 12, INVAL: 28, SRCH: 71 });
export function checkedSignal(signal: number): ProcessSignal {
  if (signal !== 2 && signal !== 9 && signal !== 13 && signal !== 15) {
    throw new ProcessError(ProcessErrno.INVAL, `unsupported signal ${signal}`);
  }
  return signal;
}
