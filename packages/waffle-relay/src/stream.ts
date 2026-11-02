import { type Exchange } from "./lifetime.js";
import { RelayError, type RelayErrorCode } from "./protocol.js";

/** Own a reader until EOF or a successful cancellation receipt, with no eager read-ahead. */
export function boundedStream(
  source: ReadableStream<Uint8Array> | null,
  job: Exchange,
  maximum: number,
  code: "request-limit" | "response-limit",
  redact = false,
): ReadableStream<Uint8Array> | null {
  if (!source) return null;
  const reader = source.getReader();
  void reader.closed.catch(() => {});
  let total = 0;
  let released = false;
  let cancellation: Promise<void> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  const signal = job.controller.signal;
  const finish = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
    release();
  };
  const cancel = (reason: unknown): Promise<void> => {
    if (released) return Promise.resolve();
    signal.removeEventListener("abort", abort);
    // A failed underlying receipt remains debt. Web Streams cannot retry its underlying cancel.
    cancellation ??= reader.cancel(reason).then(finish, () => {
      throw new RelayError("relay-unavailable");
    });
    return cancellation;
  };
  const abort = () => {
    const cancelling = cancel(signal.reason);
    output?.error(redact ? new RelayError("upstream-aborted") : signal.reason);
    void cancelling.catch(() => {});
  };
  const release = job.own({
    cancel(reason) {
      const cancelling = cancel(reason);
      output?.error(redact ? new RelayError("upstream-aborted") : reason);
      return cancelling;
    },
  });
  signal.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        if (signal.aborted) abort();
      },
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          signal.throwIfAborted();
          job.touch();
          next = await reader.read();
        } catch (error) {
          if (!released && !cancellation) finish();
          controller.error(
            redact ? safeStreamError(error, signal) : clientStreamError(error, signal),
          );
          return;
        }
        if (released || signal.aborted) return;
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > maximum) {
          const error = new RelayError(code);
          const cancelling = cancel(error);
          controller.error(error);
          job.controller.abort(error);
          await cancelling.catch(() => {});
          return;
        }
        job.touch();
        controller.enqueue(next.value);
      },
      async cancel(reason) {
        const cancelling = cancel(reason);
        job.controller.abort(reason);
        await cancelling;
      },
    },
    { highWaterMark: 0 },
  );
}

function safeStreamError(error: unknown, signal: AbortSignal): RelayError {
  const code: RelayErrorCode = signal.aborted ? "upstream-aborted" : "upstream-network";
  return error instanceof RelayError ? error : new RelayError(code);
}

function clientStreamError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason;
  return error instanceof RelayError ? error : new RelayError("relay-unavailable");
}
