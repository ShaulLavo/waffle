import type { Resource } from "../core/descriptors.js";
import { claimFileOffset, shareFileResource } from "../core/open-file.js";
import type { FilesystemClient } from "../fs/client.js";
import { errno as fsErrno, PAGE } from "../fs/protocol.js";
import { isInstance, typedArrayLength, typedArraySubarray } from "../proc/intrinsics.ts";
import { ProcessErrno, ProcessError } from "../proc/types.js";

/** Diagnostic delivery must not retain a dead/stalled process indefinitely. */
export const DIAGNOSTIC_STALL_TIMEOUT_MS = 5_000;

// Guest code can replace globals after entry; diagnostics retain host timing authority.
const now = performance.now.bind(performance);
const delay = setTimeout;
const cancelDelay = clearTimeout;

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

async function writeAsyncDiagnosticChunk(
  fs: FilesystemClient,
  handle: number,
  lease: { readonly position: number; readonly append: boolean; commit(next: number): void },
  chunk: Uint8Array,
  timeoutMs: number,
): Promise<number> {
  const completion = lease.append
    ? fs.submit("append", [handle], chunk)
    : fs.submit("write", [handle, lease.position], chunk);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = delay(
        () => {
          completion.cancel();
          reject(
            new ProcessError(
              ProcessErrno.AGAIN,
              "diagnostic reader made no progress for five seconds",
            ),
          );
        },
        Math.max(1, timeoutMs),
      );
    });
    const settled = completion.value();
    void settled.catch(() => {});
    const result = await Promise.race([settled, timedOut]);
    if (lease.append) {
      const appended = result as { written: number; offset: number };
      lease.commit(appended.offset);
      return appended.written;
    }
    const written = result as number;
    if (written > 0) lease.commit(lease.position + written);
    return written;
  } finally {
    if (timer !== undefined) cancelDelay(timer);
    completion.release();
  }
}

/** Drain diagnostic bytes to a regular file whose backend disables direct shared-memory I/O. */
export async function drainAsyncFileDiagnostic(
  fs: FilesystemClient,
  resource: Extract<Resource, { kind: "file" }>,
  bytes: Uint8Array,
  active: () => boolean,
): Promise<void> {
  const total = typedArrayLength(bytes);
  if (!total) return;
  shareFileResource(resource, fs.connection);
  let offset = 0;
  let deadline = now() + DIAGNOSTIC_STALL_TIMEOUT_MS;
  while (offset < total) {
    const remaining = total - offset;
    if (!active())
      throw new ProcessError(
        ProcessErrno.CANCELED,
        `diagnostic delivery cancelled; ${remaining} of ${total} diagnostic bytes unwritten`,
      );
    const claim = claimFileOffset(resource);
    if (claim.kind === "failed")
      throw new ProcessError(
        claim.errno,
        `diagnostic write failed (${-claim.errno}); ${remaining} of ${total} diagnostic bytes unwritten`,
      );
    if (claim.kind === "busy") {
      if (now() >= deadline)
        throw new ProcessError(
          ProcessErrno.AGAIN,
          `diagnostic reader made no progress for five seconds; ${remaining} of ${total} diagnostic bytes unwritten`,
        );
      await new Promise((resolve) => delay(resolve, 1));
      continue;
    }
    const { lease } = claim;
    const chunk = typedArraySubarray(bytes, offset, Math.min(total, offset + PAGE));
    try {
      const written = await writeAsyncDiagnosticChunk(
        fs,
        resource.handle,
        lease,
        chunk,
        deadline - now(),
      );
      if (!Number.isInteger(written) || written <= 0 || written > remaining)
        throw new ProcessError(
          29,
          `diagnostic write failed (${written}); ${remaining} of ${total} diagnostic bytes unwritten`,
        );
      offset += written;
      deadline = now() + DIAGNOSTIC_STALL_TIMEOUT_MS;
    } catch (error) {
      if (isInstance(error, ProcessError)) throw error;
      const code = fsErrno(error);
      throw new ProcessError(
        code,
        `diagnostic write failed (${-code}); ${remaining} of ${total} diagnostic bytes unwritten`,
      );
    } finally {
      lease.release();
    }
  }
}
