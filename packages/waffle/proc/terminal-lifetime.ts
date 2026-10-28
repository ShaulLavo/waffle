import { controlCas, controlLoad, type TaggedCells } from "./control.js";
import {
  directoryState,
  isCollectedProcess,
  wakeDirectory,
  type DirectoryHandle,
} from "./directory.js";
import { atomicsLoad, atomicsWaitAsync } from "./intrinsics.ts";

type State = ReturnType<typeof directoryState>;

/** Open counts are nonnegative; revoked counts are -(active + 1). */
export function enterTerminalSection(state: State): boolean {
  for (;;) {
    const count = controlLoad(state.terminalAdmission);
    if (count < 0 || count === 0x7fffffff) return false;
    if (controlCas(state.terminalAdmission, 0, count, count + 1) === count) return true;
  }
}

export function leaveTerminalSection(state: State, directory: SharedArrayBuffer): void {
  for (;;) {
    const count = controlLoad(state.terminalAdmission);
    const next = count < 0 ? count + 1 : count - 1;
    if (controlCas(state.terminalAdmission, 0, count, next) !== count) continue;
    if (next === -1) wakeDirectory(directory);
    return;
  }
}

export interface TerminalProcessLifetime {
  /** Revoke new sections and join admitted work before stopping the native consumer. */
  quiesce(): void | Promise<void>;
  /** Trusted host only: the exact captured native consumer has successfully stopped. */
  stopped(): void;
}

function revoke(admission: TaggedCells): void {
  for (;;) {
    const count = controlLoad(admission);
    if (count < 0 || controlCas(admission, 0, count, -count - 1) === count) return;
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
  function complete(): boolean {
    quiet = controlLoad(state.terminalAdmission) === -1 || controlLoad(state.terminalStopped) !== 0;
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
    revoke(state.terminalAdmission);
    if (controlLoad(state.terminalAdmission) !== -1) {
      if (!onInterrupted)
        throw new Error("Interrupted terminal sections need a resource death acknowledgement");
      onInterrupted();
    }
    controlCas(state.terminalStopped, 0, 0, 1);
    wakeDirectory(process.directory);
  }
  return {
    quiesce() {
      if (quiet) return;
      revoke(state.terminalAdmission);
      return complete() ? undefined : join();
    },
    stopped() {
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
