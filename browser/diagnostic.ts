import { ProcessErrno, ProcessError } from "../proc/types.js";

/** Diagnostic delivery must not retain a dead/stalled process indefinitely. */
export const DIAGNOSTIC_STALL_TIMEOUT_MS = 5_000;

// Guest code can replace globals after entry; diagnostics retain host timing authority.
const now = performance.now.bind(performance);
const delay = setTimeout;

/** Drain partial writes without blocking the page/Worker event loop. Positive writes reset
 * the no-progress deadline; a draining reader always gets every byte. The synchronous fast
 * path preserves ordered completion for sinks that never backpressure. Delivery errors carry
 * the unwritten span and never select the process outcome themselves.
 */
export function drainDiagnostic(
  bytes: Uint8Array,
  write: (bytes: Uint8Array) => number,
  active: () => boolean = () => true,
): void | Promise<void> {
  let offset = 0, deadline = now() + DIAGNOSTIC_STALL_TIMEOUT_MS;
  const step = (): boolean => {
    for (; offset < bytes.length;) {
      const remaining = bytes.length - offset;
      const fail = (errno: number, reason: string): never => {
        throw new ProcessError(errno, `${reason}; ${remaining} of ${bytes.length} diagnostic bytes unwritten`);
      };
      if (!active()) fail(ProcessErrno.CANCELED, "diagnostic delivery cancelled");
      let written: number;
      try {
        written = write(bytes.subarray(offset));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        fail(29 /* WASI EIO */, `diagnostic write threw (${reason})`);
      }
      if (written === -ProcessErrno.AGAIN) {
        if (now() >= deadline) fail(ProcessErrno.AGAIN, "diagnostic reader made no progress for five seconds");
        return false;
      }
      if (!Number.isInteger(written) || written <= 0 || written > remaining) {
        fail(written < 0 ? -written : 29 /* WASI EIO */, `diagnostic write failed (${written})`);
      }
      offset += written;
      deadline = now() + DIAGNOSTIC_STALL_TIMEOUT_MS;
    }
    return true;
  };
  if (step()) return;
  return (async () => {
    do { await new Promise(resolve => delay(resolve, 1)); } while (!step());
  })();
}
