import type { Resource } from "../core/descriptors.js";
import {
  claimFileOffset,
  shareFileResource,
  type AsyncFileOffsetLease,
} from "../core/open-file.js";
import type { FilesystemClient, FilesystemCompletion } from "../fs/client.js";
import { errno as fsErrno, PAGE } from "../fs/protocol.js";
import {
  cancelTimeout,
  isInstance,
  PromiseConstructor,
  scheduleTimeout,
  typedArrayLength,
  typedArraySubarray,
} from "../proc/intrinsics.ts";
import { ProcessErrno, ProcessError } from "../proc/types.js";

/** Diagnostic delivery must not retain a dead/stalled process indefinitely. */
export const DIAGNOSTIC_STALL_TIMEOUT_MS = 5_000;

// Guest code can replace globals after entry; diagnostics retain host timing and math authority.
const now = performance.now.bind(performance);
const delay = scheduleTimeout;
const mathMin = Math.min;
const mathMax = Math.max;
const numberIsInteger = Number.isInteger;

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
  let offset = 0,
    deadline = now() + DIAGNOSTIC_STALL_TIMEOUT_MS;
  const step = (): boolean => {
    for (; offset < bytes.length;) {
      const remaining = bytes.length - offset;
      const fail = (errno: number, reason: string): never => {
        throw new ProcessError(
          errno,
          `${reason}; ${remaining} of ${bytes.length} diagnostic bytes unwritten`,
        );
      };
      if (!active()) fail(ProcessErrno.CANCELED, "diagnostic delivery cancelled");
      let written = 0;
      try {
        written = write(bytes.subarray(offset));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        fail(29 /* WASI EIO */, `diagnostic write threw (${reason})`);
      }
      if (written === -ProcessErrno.AGAIN) {
        if (now() >= deadline)
          fail(ProcessErrno.AGAIN, "diagnostic reader made no progress for five seconds");
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
    do {
      await new Promise((resolve) => delay(resolve, 1));
    } while (!step());
  })();
}

function diagnosticWriteError(error: unknown, remaining: number, total: number): ProcessError {
  if (isInstance(error, ProcessError)) return error;
  const code = fsErrno(error);
  return new ProcessError(
    code,
    `diagnostic write failed (${-code}); ${remaining} of ${total} diagnostic bytes unwritten`,
  );
}

function settleAsyncDiagnosticChunk(
  completion: FilesystemCompletion,
  lease: AsyncFileOffsetLease,
  remaining: number,
  total: number,
  callerSettled: boolean,
  releaseLease: () => void,
  onAccept: (written: number) => void,
  onReject: (error: ProcessError) => void,
): void {
  let written = 0;
  try {
    const committed = completion.tryConsumeCommitted();
    const result = committed !== undefined ? committed : completion.consumeInline();
    if (lease.append) {
      const appended = result as { written: number; offset: number };
      lease.commit(appended.offset);
      written = appended.written;
    } else {
      written = result as number;
      if (written > 0) lease.commit(lease.position + written);
    }
  } catch (error) {
    completion.release();
    releaseLease();
    if (!callerSettled) onReject(diagnosticWriteError(error, remaining, total));
    return;
  }
  completion.release();
  releaseLease();
  if (callerSettled) return;
  if (!numberIsInteger(written) || written <= 0 || written > remaining) {
    onReject(
      new ProcessError(
        29,
        `diagnostic write failed (${written}); ${remaining} of ${total} diagnostic bytes unwritten`,
      ),
    );
    return;
  }
  onAccept(written);
}

function dispatchAsyncDiagnosticChunk(
  fs: FilesystemClient,
  handle: number,
  lease: AsyncFileOffsetLease,
  bytes: Uint8Array,
  offset: number,
  total: number,
  deadline: number,
  onWritten: (written: number) => void,
  onError: (error: ProcessError) => void,
): void {
  const remaining = total - offset;
  let leaseReleased = false;
  const releaseLease = () => {
    if (leaseReleased) return;
    leaseReleased = true;
    lease.release();
  };
  let completion: FilesystemCompletion;
  try {
    if (now() >= deadline) {
      releaseLease();
      onError(
        new ProcessError(
          ProcessErrno.AGAIN,
          `diagnostic reader made no progress for five seconds; ${remaining} of ${total} diagnostic bytes unwritten`,
        ),
      );
      return;
    }
    const chunk = typedArraySubarray(bytes, offset, mathMin(total, offset + PAGE));
    completion = lease.append
      ? fs.submit("append", [handle], chunk)
      : fs.submit("write", [handle, lease.position], chunk);
  } catch (error) {
    releaseLease();
    onError(diagnosticWriteError(error, remaining, total));
    return;
  }
  let callerSettled = false;
  let settled = false;
  // Once dispatched, keep the shared offset lease until the backend reports an authoritative
  // commit or abort so another holder cannot reuse the same offset while the write is still live.
  const timer = delay(
    () => {
      if (callerSettled) return;
      callerSettled = true;
      onError(
        new ProcessError(
          ProcessErrno.AGAIN,
          `diagnostic reader made no progress for five seconds; ${remaining} of ${total} diagnostic bytes unwritten`,
        ),
      );
    },
    mathMax(1, deadline - now()),
  );
  completion.onBackendSettled(() => {
    if (settled) return;
    settled = true;
    cancelTimeout(timer);
    settleAsyncDiagnosticChunk(
      completion,
      lease,
      remaining,
      total,
      callerSettled,
      releaseLease,
      (written) => {
        if (callerSettled) return;
        callerSettled = true;
        onWritten(written);
      },
      (error) => {
        if (callerSettled) return;
        callerSettled = true;
        onError(error);
      },
    );
  });
}

/** Drain diagnostic bytes to a regular file whose backend disables direct shared-memory I/O. */
export function drainAsyncFileDiagnostic(
  fs: FilesystemClient,
  resource: Extract<Resource, { kind: "file" }>,
  bytes: Uint8Array,
  active: () => boolean,
  stallTimeoutMs = DIAGNOSTIC_STALL_TIMEOUT_MS,
): Promise<void> {
  return new PromiseConstructor<void>((resolve, reject) => {
    const total = typedArrayLength(bytes);
    if (!total) {
      resolve();
      return;
    }
    try {
      shareFileResource(resource, fs.connection);
    } catch (error) {
      reject(diagnosticWriteError(error, total, total));
      return;
    }
    let offset = 0;
    let deadline = now() + stallTimeoutMs;
    const step = (): void => {
      if (offset >= total) {
        resolve();
        return;
      }
      const remaining = total - offset;
      if (!active()) {
        reject(
          new ProcessError(
            ProcessErrno.CANCELED,
            `diagnostic delivery cancelled; ${remaining} of ${total} diagnostic bytes unwritten`,
          ),
        );
        return;
      }
      const claim = claimFileOffset(resource);
      if (claim.kind === "failed") {
        reject(
          new ProcessError(
            claim.errno,
            `diagnostic write failed (${-claim.errno}); ${remaining} of ${total} diagnostic bytes unwritten`,
          ),
        );
        return;
      }
      if (claim.kind === "busy") {
        if (now() >= deadline) {
          reject(
            new ProcessError(
              ProcessErrno.AGAIN,
              `diagnostic reader made no progress for five seconds; ${remaining} of ${total} diagnostic bytes unwritten`,
            ),
          );
          return;
        }
        delay(step, 1);
        return;
      }
      dispatchAsyncDiagnosticChunk(
        fs,
        resource.handle,
        claim.lease,
        bytes,
        offset,
        total,
        deadline,
        (written) => {
          offset += written;
          deadline = now() + stallTimeoutMs;
          step();
        },
        reject,
      );
    };
    step();
  });
}
