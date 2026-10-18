import { type ControlCells, TaggedCells, controlLoad, controlStore, controlCas, controlExchange, controlNotify } from "./control.ts";
import type { OutcomeWord } from "./outcome.ts";
import { claimOutcome, readOutcome } from "./outcome.ts";
import { ProcessErrno, ProcessError, Signal, checkedSignal, type ProcessExit } from "./types.ts";

/** Shared ABI: cell zero is reserved; signal numbers 1..64 index their own cell. */
export const SignalDisposition = Object.freeze({ DEFAULT: 0, IGNORE: 1, HANDLE: 2 });
export const SIGNAL_PENDING = 4;
const DISPOSITION_MASK = 3;

export function createSignalState(source?: ControlCells | SharedArrayBuffer): ControlCells {
  const state = source instanceof TaggedCells ? source : source instanceof Int32Array ? source : new Int32Array(source ?? new SharedArrayBuffer(65 * 4));
  if (!(state.buffer instanceof SharedArrayBuffer) || state.length !== 65) throw new TypeError("signal state must be 65 shared int32 cells");
  return state;
}
export function checkedSignalNumber(signal: number): number {
  return checkedSignal(signal);
}
/** SIGCONT is a no-op for a running process; stopped processes are not supported. */
export function defaultSignalTerminates(signal: number): boolean {
  checkedSignalNumber(signal);
  return signal !== Signal.SIGCHLD && signal !== Signal.SIGCONT && signal !== Signal.SIGURG && signal !== Signal.SIGWINCH;
}
export function signalDisposition(state: ControlCells, signal: number): number {
  checkedSignalNumber(signal);
  return controlLoad(state, signal) & DISPOSITION_MASK;
}
/** The caller must synchronously claim the default terminal outcome when this returns true. */
export function setSignalDisposition(state: ControlCells, signal: number, disposition: number, interrupt?: ControlCells): boolean {
  checkedSignalNumber(signal);
  if (signal === Signal.SIGKILL || !Number.isInteger(disposition) || disposition < 0 || disposition > 2) {
    throw new ProcessError(ProcessErrno.INVAL, "invalid signal disposition");
  }
  for (;;) {
    const previous = controlLoad(state, signal);
    const next = disposition | (disposition === SignalDisposition.HANDLE ? previous & SIGNAL_PENDING : 0);
    if (controlCas(state, signal, previous, next) === previous) {
      if (interrupt && disposition !== SignalDisposition.HANDLE) {
        // Remove only this discarded delivery's hint, never a racing signal or KILL.
        // A publisher racing the clear retains either its pending bit or its wake.
        controlCas(interrupt, 0, signal, 0);
        rearmPendingSignal(state, interrupt);
      }
      return disposition === SignalDisposition.DEFAULT && (previous & SIGNAL_PENDING) !== 0 && defaultSignalTerminates(signal);
    }
  }
}
/** Classification and pending publication share one CAS, so registration cannot race delivery. */
export function publishSignal(state: ControlCells, signal: number): "default" | "ignore" | "handled" {
  checkedSignalNumber(signal);
  if (signal === Signal.SIGKILL) return "default";
  for (;;) {
    const previous = controlLoad(state, signal);
    const disposition = previous & DISPOSITION_MASK;
    if (disposition === SignalDisposition.DEFAULT) return defaultSignalTerminates(signal) ? "default" : "ignore";
    if (disposition === SignalDisposition.IGNORE) return "ignore";
    if (disposition !== SignalDisposition.HANDLE) throw new ProcessError(ProcessErrno.INVAL, "invalid shared signal disposition");
    if (controlCas(state, signal, previous, previous | SIGNAL_PENDING) === previous) return "handled";
  }
}
/** Clear before dispatch: removing a once handler must not reinterpret its delivered pending bit.
 * Keep the wake hint armed while another authoritative pending bit remains, including for WASI
 * waits that observe the interrupt word rather than the entire signal-state table. */
export function takeSignal(state: ControlCells, interrupt?: ControlCells): number {
  // A racing publisher must retain either its wake hint or its pending bit.
  if (interrupt) controlExchange(interrupt, 0, 0);
  const taken = takePendingSignal(state);
  if (interrupt) rearmPendingSignal(state, interrupt);
  return taken;
}
function rearmPendingSignal(state: ControlCells, interrupt: ControlCells): void {
  for (let signal = 1; signal <= 64; signal++) {
    if ((controlLoad(state, signal) & (DISPOSITION_MASK | SIGNAL_PENDING)) !== (SignalDisposition.HANDLE | SIGNAL_PENDING)) continue;
    controlCas(interrupt, 0, 0, signal);
    break;
  }
}
function takePendingSignal(state: ControlCells): number {
  for (let signal = 1; signal <= 64; signal++) {
    if (signal === Signal.SIGKILL) continue;
    for (;;) {
      const previous = controlLoad(state, signal);
      if ((previous & (DISPOSITION_MASK | SIGNAL_PENDING)) !== (SignalDisposition.HANDLE | SIGNAL_PENDING)) break;
      if (controlCas(state, signal, previous, previous & ~SIGNAL_PENDING) === previous) return signal;
    }
  }
  return 0;
}

export interface SignalTransport {
  readonly signalState: ControlCells;
  readonly interrupt: ControlCells;
  readonly requestedSignal: ControlCells;
  readonly outcome: OutcomeWord;
}
export interface SignalRequestResult {
  readonly action: "default" | "ignore" | "handled" | "settled";
  readonly outcome: ProcessExit | null;
}
// Preserve KILL across writers, including publication racing an already consumed wake hint.
function publishWord(word: ControlCells, signal: number): number {
  for (;;) {
    const previous = controlLoad(word, 0);
    if (previous === Signal.SIGKILL) return previous;
    if (controlCas(word, 0, previous, signal) === previous) return signal;
  }
}
function publishWake(transport: SignalTransport, signal: number): void {
  let delivered = publishWord(transport.requestedSignal, signal);
  if (controlLoad(transport.requestedSignal, 0) === Signal.SIGKILL) delivered = Signal.SIGKILL;
  delivered = publishWord(transport.interrupt, delivered);
  if (controlLoad(transport.requestedSignal, 0) === Signal.SIGKILL) delivered = Signal.SIGKILL;
  if (delivered === Signal.SIGKILL) {
    claimOutcome(transport.outcome, { kind: "signaled", code: Signal.SIGKILL });
    publishWord(transport.requestedSignal, Signal.SIGKILL);
    publishWord(transport.interrupt, Signal.SIGKILL);
  }
  controlNotify(transport.interrupt, 0);
}
/** One authoritative delivery, usable before supervisor activation. No callbacks or teardown.
 * Publish all job members before observing outcomes to avoid reentrant sibling exits/spawns.
 */
export function requestSignal(transport: SignalTransport, signal: number): SignalRequestResult {
  checkedSignalNumber(signal);
  const settled = readOutcome(transport.outcome);
  if (settled) {
    if (settled.kind === "signaled" && settled.code === Signal.SIGKILL) publishWake(transport, Signal.SIGKILL);
    return { action: "settled", outcome: settled };
  }
  if (controlLoad(transport.requestedSignal, 0) === Signal.SIGKILL) signal = Signal.SIGKILL;
  const action = publishSignal(transport.signalState, signal);
  if (action === "ignore") return { action, outcome: readOutcome(transport.outcome) };
  if (action === "default") {
    const outcome = claimOutcome(transport.outcome, { kind: "signaled", code: signal });
    if (outcome.kind !== "signaled" || outcome.code !== signal) return { action: "settled", outcome };
  }
  publishWake(transport, signal);
  if (action === "handled") {
    const cell = controlLoad(transport.signalState, signal);
    if ((cell & (DISPOSITION_MASK | SIGNAL_PENDING)) !== (SignalDisposition.HANDLE | SIGNAL_PENDING)) {
      // Registration can discard the pending bit before this publisher reaches its wake.
      // Clear only our hint, then preserve re-registration and any terminal publication.
      controlCas(transport.interrupt, 0, signal, 0);
      rearmPendingSignal(transport.signalState, transport.interrupt);
      const winner = readOutcome(transport.outcome);
      if (winner?.kind === "signaled") publishWake(transport, winner.code);
    }
  }
  return { action, outcome: readOutcome(transport.outcome) };
}

/** Nonconsuming readiness: interrupt is only a wake hint and may outlive a delivery. */
export function signalPending(transport: SignalTransport): boolean {
  if (controlLoad(transport.requestedSignal, 0) === Signal.SIGKILL || readOutcome(transport.outcome)?.kind === "signaled") return true;
  for (let signal = 1; signal <= 64; signal++) {
    if ((controlLoad(transport.signalState, signal) & (DISPOSITION_MASK | SIGNAL_PENDING)) === (SignalDisposition.HANDLE | SIGNAL_PENDING)) return true;
  }
  return false;
}
