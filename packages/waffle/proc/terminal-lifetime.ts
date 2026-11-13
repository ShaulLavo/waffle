import { controlCas, controlLoad, type TaggedCells } from "./control.js";
import {
  directoryState,
  isCollectedProcess,
  wakeDirectory,
  type DirectoryHandle,
} from "./directory.js";
import { atomicsLoad, atomicsWaitAsync } from "./intrinsics.ts";

type State = ReturnType<typeof directoryState>;
export const TERMINAL_FINAL_QUIET = -0x80000000;
const MAX_SECTIONS = 0x3fffffff;
const FINAL_BOUNDARY = -0x40000000;

/** Handoff closure is -(active + 1); final closure is INT_MIN + active. */
export function enterTerminalSection(state: State): boolean {
  for (;;) {
    const count = controlLoad(state.terminalAdmission);
    if (count < 0 || count >= MAX_SECTIONS) return false;
    if (controlCas(state.terminalAdmission, 0, count, count + 1) === count) return true;
  }
}

export function leaveTerminalSection(state: State, directory: SharedArrayBuffer): void {
  for (;;) {
    const count = controlLoad(state.terminalAdmission);
    const next = count < 0 && count >= FINAL_BOUNDARY ? count + 1 : count - 1;
    if (controlCas(state.terminalAdmission, 0, count, next) !== count) continue;
    if (next === -1 || next === TERMINAL_FINAL_QUIET) wakeDirectory(directory);
    return;
  }
}

export interface TerminalProcessLifetime {
  /** Join this image and rearm only while its committed replacement remains live. */
  handoff(active: () => boolean): Promise<boolean>;
  /** Revoke new sections and join admitted work before stopping the native consumer. */
  quiesce(): void | Promise<void>;
  /** Trusted host only: the exact captured native consumer has successfully stopped. */
  stopped(): void;
}

function revoke(admission: TaggedCells, final = false): void {
  for (;;) {
    const count = controlLoad(admission);
    if (count < FINAL_BOUNDARY || (count < 0 && !final)) return;
    const active = count < 0 ? -count - 1 : count;
    const next = final ? TERMINAL_FINAL_QUIET + active : -active - 1;
    if (controlCas(admission, 0, count, next) === count) return;
  }
}

/** Capture before publication/collection; no PID lookup is performed after physical stop.
 * onInterrupted must fail closed every resource reachable by this native consumer. */
export function captureTerminalLifetime(
  process: DirectoryHandle,
  onInterrupted?: () => void,
): TerminalProcessLifetime {
  const state = directoryState(process);
  let quiet = false;
  let final = false;
  let handoffGeneration = 0;
  function complete(): boolean {
    const count = controlLoad(state.terminalAdmission);
    quiet =
      count === -1 || count === TERMINAL_FINAL_QUIET || controlLoad(state.terminalStopped) !== 0;
    return quiet;
  }
  async function join(): Promise<void> {
    for (;;) {
      const seen = atomicsLoad(state.wake, 0);
      if (complete()) return;
      const waiting = atomicsWaitAsync(state.wake, 0, seen);
      if (waiting.async) await waiting.value;
    }
  }
  function acknowledge(): void {
    if (controlLoad(state.terminalStopped) !== 0) return;
    revoke(state.terminalAdmission, true);
    if (controlLoad(state.terminalAdmission) !== TERMINAL_FINAL_QUIET) {
      if (!onInterrupted)
        throw new Error("Interrupted terminal sections need a resource death acknowledgement");
      onInterrupted();
    }
    controlCas(state.terminalStopped, 0, 0, 1);
    wakeDirectory(process.directory);
  }
  return {
    async handoff(active) {
      if (final || !active()) return false;
      const generation = ++handoffGeneration;
      try {
        revoke(state.terminalAdmission);
        if (!complete()) await join();
      } catch (error) {
        if (final && isCollectedProcess(error)) return false;
        throw error;
      }
      if (final || generation !== handoffGeneration || !active()) return false;
      if (controlLoad(state.terminalStopped) !== 0) return false;
      if (controlCas(state.terminalAdmission, 0, -1, 0) !== -1) return false;
      quiet = false;
      return true;
    },
    quiesce() {
      final = true;
      try {
        revoke(state.terminalAdmission, true);
        return complete() ? undefined : join();
      } catch (error) {
        if (!quiet || !isCollectedProcess(error)) throw error;
      }
    },
    stopped() {
      final = true;
      try {
        acknowledge();
      } catch (error) {
        // A joined incarnation can be collected before its native stop settles. A stale
        // success has nothing left to publish and must never touch a replacement row.
        if (!quiet || !isCollectedProcess(error)) throw error;
      }
    },
  };
}
