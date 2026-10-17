import { claimOutcome, readOutcome } from "./outcome.js";
import { ProcessErrno, ProcessError, Signal, checkedSignal, type ProcessExit } from "./types.js";

/** Shared ABI: cell zero is reserved; signal numbers 1..64 index their own cell. */
export const SignalDisposition = Object.freeze({ DEFAULT: 0, IGNORE: 1, HANDLE: 2 });
export const SIGNAL_PENDING = 4;
const DISPOSITION_MASK = 3;

export function createSignalState(source?: Int32Array | SharedArrayBuffer): Int32Array {
  const state = source instanceof Int32Array ? source : new Int32Array(source ?? new SharedArrayBuffer(65 * 4));
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
export function signalDisposition(state: Int32Array, signal: number): number {
  checkedSignalNumber(signal);
  return Atomics.load(state, signal) & DISPOSITION_MASK;
}
/** The caller must synchronously claim the default terminal outcome when this returns true. */
export function setSignalDisposition(state: Int32Array, signal: number, disposition: number, interrupt?: Int32Array): boolean {
  checkedSignalNumber(signal);
  if (signal === Signal.SIGKILL || !Number.isInteger(disposition) || disposition < 0 || disposition > 2) {
    throw new ProcessError(ProcessErrno.INVAL, "invalid signal disposition");
  }
  for (;;) {
    const previous = Atomics.load(state, signal);
    const next = disposition | (disposition === SignalDisposition.HANDLE ? previous & SIGNAL_PENDING : 0);
    if (Atomics.compareExchange(state, signal, previous, next) === previous) {
      if (interrupt && disposition !== SignalDisposition.HANDLE) {
        // Remove only this discarded delivery's hint, never a racing signal or KILL.
        // A publisher racing the clear retains either its pending bit or its wake.
        Atomics.compareExchange(interrupt, 0, signal, 0);
        rearmPendingSignal(state, interrupt);
      }
      return disposition === SignalDisposition.DEFAULT && (previous & SIGNAL_PENDING) !== 0 && defaultSignalTerminates(signal);
    }
  }
}
/** Classification and pending publication share one CAS, so registration cannot race delivery. */
export function publishSignal(state: Int32Array, signal: number): "default" | "ignore" | "handled" {
  checkedSignalNumber(signal);
  if (signal === Signal.SIGKILL) return "default";
  for (;;) {
    const previous = Atomics.load(state, signal);
    const disposition = previous & DISPOSITION_MASK;
    if (disposition === SignalDisposition.DEFAULT) return defaultSignalTerminates(signal) ? "default" : "ignore";
    if (disposition === SignalDisposition.IGNORE) return "ignore";
    if (disposition !== SignalDisposition.HANDLE) throw new ProcessError(ProcessErrno.INVAL, "invalid shared signal disposition");
    if (Atomics.compareExchange(state, signal, previous, previous | SIGNAL_PENDING) === previous) return "handled";
  }
}
/** Clear before dispatch: removing a once handler must not reinterpret its delivered pending bit.
 * Keep the wake hint armed while another authoritative pending bit remains, including for WASI
 * waits that observe the interrupt word rather than the entire signal-state table. */
export function takeSignal(state: Int32Array, interrupt?: Int32Array): number {
  // A racing publisher must retain either its wake hint or its pending bit.
  if (interrupt) Atomics.exchange(interrupt, 0, 0);
  const taken = takePendingSignal(state);
  if (interrupt) rearmPendingSignal(state, interrupt);
  return taken;
}
function rearmPendingSignal(state: Int32Array, interrupt: Int32Array): void {
  for (let signal = 1; signal <= 64; signal++) {
    if ((Atomics.load(state, signal) & (DISPOSITION_MASK | SIGNAL_PENDING)) !== (SignalDisposition.HANDLE | SIGNAL_PENDING)) continue;
    Atomics.compareExchange(interrupt, 0, 0, signal);
    break;
  }
}
function takePendingSignal(state: Int32Array): number {
  for (let signal = 1; signal <= 64; signal++) {
    if (signal === Signal.SIGKILL) continue;
    for (;;) {
      const previous = Atomics.load(state, signal);
      if ((previous & (DISPOSITION_MASK | SIGNAL_PENDING)) !== (SignalDisposition.HANDLE | SIGNAL_PENDING)) break;
      if (Atomics.compareExchange(state, signal, previous, previous & ~SIGNAL_PENDING) === previous) return signal;
    }
  }
  return 0;
}

export interface SignalTransport {
  readonly signalState: Int32Array;
  readonly interrupt: Int32Array;
  readonly requestedSignal: Int32Array;
  readonly outcome: BigInt64Array;
}
export interface SignalRequestResult {
  readonly action: "default" | "ignore" | "handled" | "settled";
  readonly outcome: ProcessExit | null;
}
// Preserve KILL across writers, including publication racing an already consumed wake hint.
function publishWord(word: Int32Array, signal: number): number {
  for (;;) {
    const previous = Atomics.load(word, 0);
    if (previous === Signal.SIGKILL) return previous;
    if (Atomics.compareExchange(word, 0, previous, signal) === previous) return signal;
  }
}
function publishWake(transport: SignalTransport, signal: number): void {
  let delivered = publishWord(transport.requestedSignal, signal);
  if (Atomics.load(transport.requestedSignal, 0) === Signal.SIGKILL) delivered = Signal.SIGKILL;
  delivered = publishWord(transport.interrupt, delivered);
  if (Atomics.load(transport.requestedSignal, 0) === Signal.SIGKILL) delivered = Signal.SIGKILL;
  if (delivered === Signal.SIGKILL) {
    claimOutcome(transport.outcome, { kind: "signaled", code: Signal.SIGKILL });
    publishWord(transport.requestedSignal, Signal.SIGKILL);
    publishWord(transport.interrupt, Signal.SIGKILL);
  }
  Atomics.notify(transport.interrupt, 0);
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
  if (Atomics.load(transport.requestedSignal, 0) === Signal.SIGKILL) signal = Signal.SIGKILL;
  const action = publishSignal(transport.signalState, signal);
  if (action === "ignore") return { action, outcome: readOutcome(transport.outcome) };
  if (action === "default") {
    const outcome = claimOutcome(transport.outcome, { kind: "signaled", code: signal });
    if (outcome.kind !== "signaled" || outcome.code !== signal) return { action: "settled", outcome };
  }
  publishWake(transport, signal);
  return { action, outcome: readOutcome(transport.outcome) };
}
