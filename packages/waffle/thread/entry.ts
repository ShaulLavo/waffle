import { WasiExit } from "../core/wasi.ts";
import { ExecutionUnwind } from "../core/unwind.ts";
import {
  claimOutcome,
  markStarted,
  readOutcome,
  startStatus,
  processOutcome,
  type OutcomeWord,
} from "../proc/outcome.ts";
import type { ProcessExit } from "../proc/types.ts";
import { atomicsAdd, atomicsNotify } from "../proc/intrinsics.ts";
import type { ThreadKey } from "./protocol.ts";

export type GuestEntry = { kind: "initial" } | { kind: "secondary"; tid: number; startArg: number };
export type GuestReport =
  | { kind: "thread-returned"; thread: ThreadKey }
  | { kind: "process-terminal"; thread: ThreadKey; winner: ProcessExit }
  | { kind: "host-idle"; thread: ThreadKey };

/** This route belongs to the process coordinator, never to the syscall request queue. */
export class GuestTerminal {
  constructor(
    private readonly options: Readonly<{
      thread: ThreadKey;
      outcome: OutcomeWord;
      signal: Int32Array;
      report(report: GuestReport): void;
    }>,
  ) {}

  get winner(): ProcessExit | null {
    return readOutcome(this.options.outcome);
  }
  get started(): boolean {
    return startStatus(this.options.outcome) === 0;
  }

  claim(result: ProcessExit): ProcessExit {
    const winner = claimOutcome(this.options.outcome, result);
    this.wake();
    return winner;
  }

  report(winner: ProcessExit): void {
    try {
      this.options.report({ kind: "process-terminal", thread: this.options.thread, winner });
    } finally {
      this.wake();
    }
  }

  start(): boolean {
    return markStarted(this.options.outcome);
  }
  returned(): void {
    this.options.report({ kind: "thread-returned", thread: this.options.thread });
  }
  idle(): void {
    this.options.report({ kind: "host-idle", thread: this.options.thread });
  }

  private wake(): void {
    atomicsAdd(this.options.signal, 0, 1);
    atomicsNotify(this.options.signal, 0);
  }
}

export function guestProcExit(code: number, terminal: GuestTerminal): never {
  const winner = terminal.claim(processOutcome({ kind: "exited", code: code & 0xff }));
  try {
    terminal.report(winner);
  } catch {
    // The shared outcome and wake still reach the owner if the control port has closed.
  }
  throw new WasiExit(code & 0xff);
}

/** The caller builds the proxy imports, including guestProcExit, before this instantiation. */
export async function enterGuest(
  entry: GuestEntry,
  terminal: GuestTerminal,
  instantiate: () => WebAssembly.Instance | Promise<WebAssembly.Instance>,
): Promise<void> {
  let entered = false;
  try {
    if (terminal.winner) return;
    const instance = await instantiate();
    if (terminal.winner) return;
    const start = instance.exports[entry.kind === "initial" ? "_start" : "wasi_thread_start"];
    if (typeof start !== "function") throw new Error("thread guest entry is missing");
    if (entry.kind === "initial" && !terminal.start()) return;
    entered = true;
    if (entry.kind === "secondary") start(entry.tid, entry.startArg);
    else start();
    if (entry.kind === "secondary") terminal.returned();
    else terminal.report(terminal.claim(processOutcome({ kind: "exited", code: 0 })));
  } catch (error) {
    const winner =
      terminal.winner ?? terminal.claim(entryFailure(error, entry, entered, terminal.started));
    terminal.report(winner);
  } finally {
    terminal.idle();
  }
}

function entryFailure(
  error: unknown,
  entry: GuestEntry,
  entered: boolean,
  started: boolean,
): ProcessExit {
  if (error instanceof WasiExit) return processOutcome({ kind: "exited", code: error.code & 0xff });
  if (error instanceof ExecutionUnwind && "signal" in error && typeof error.signal === "number")
    return processOutcome({ kind: "signaled", code: error.signal });
  return processOutcome(
    entry.kind === "initial" && !entered && !started
      ? { kind: "start-failed", code: 5 }
      : { kind: "exited", code: 1 },
  );
}
