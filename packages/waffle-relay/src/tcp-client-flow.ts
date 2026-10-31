import { TcpFlow } from "./tcp-flow.js";
import { RelayConnectError, type TcpRemote, type TcpStream } from "./tcp-protocol.js";

export function clientFlow(
  flow: TcpFlow,
  remote: TcpRemote,
  signal: AbortSignal,
  session?: AbortSignal,
) {
  let readEnded = false;
  let discarding = false;
  let finRequested = false;
  let readController: ReadableStreamDefaultController<Uint8Array>;
  let writeController: WritableStreamDefaultController;
  const failure = () => (signal.aborted ? signal.reason : new RelayConnectError("ECONNRESET"));
  const reset = () => flow.reset(failure(), 1);
  const abort = () => {
    void reset().catch(() => {});
  };
  const write = async (bytes: Uint8Array) => {
    try {
      await flow.write(bytes);
    } catch {
      throw failure();
    }
  };
  const finish = async () => {
    try {
      await flow.fin();
    } catch {
      throw failure();
    }
  };
  const discard = async () => {
    try {
      for (;;) {
        const bytes = await flow.read();
        if (!bytes) return;
        flow.consume(bytes.length, true);
      }
    } catch {}
  };
  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        readController = controller;
      },
      async pull(controller) {
        try {
          const bytes = await flow.read();
          if (readEnded || discarding) return;
          if (!bytes) {
            readEnded = true;
            controller.close();
            return;
          }
          controller.enqueue(bytes);
          flow.consume(bytes.length);
        } catch {
          if (!readEnded) {
            readEnded = true;
            controller.error(signal.aborted ? signal.reason : new RelayConnectError("ECONNRESET"));
          }
        }
      },
      cancel() {
        readEnded = true;
        if (!finRequested && !flow.state.localFin)
          return flow.reset(new RelayConnectError("ECONNRESET"), 1);
        discarding = true;
        flow.fullClose();
        void discard();
        return flow.closed;
      },
    },
    { highWaterMark: 0 },
  );
  const writable = new HalfCloseWritable(
    {
      start(controller) {
        writeController = controller;
        controller.signal.addEventListener("abort", abort, { once: true });
      },
      write,
      close: finish,
      abort: reset,
    },
    () => {
      finRequested = true;
    },
  );
  signal.addEventListener("abort", abort, { once: true });
  session?.addEventListener("abort", abort, { once: true });
  if (signal.aborted || session?.aborted) abort();
  void flow.done
    .catch(() => {
      const error = signal.aborted ? signal.reason : new RelayConnectError("ECONNRESET");
      if (!readEnded) {
        readEnded = true;
        readController.error(error);
      }
      writeController.error(error);
    })
    .finally(() => {
      signal.removeEventListener("abort", abort);
      session?.removeEventListener("abort", abort);
    });
  const stream: TcpStream = {
    readable,
    writable,
    remote,
    get counters() {
      return flow.counters;
    },
  };
  return { stream, closed: flow.closed };
}

class HalfCloseWriter extends WritableStreamDefaultWriter<Uint8Array> {
  constructor(
    stream: WritableStream<Uint8Array>,
    private requested: () => void,
  ) {
    super(stream);
  }
  override close(): Promise<void> {
    this.requested();
    return super.close();
  }
}
/** A queued writer.close() must remain visible while its earlier DATA waits for credit. */
class HalfCloseWritable extends WritableStream<Uint8Array> {
  constructor(
    sink: UnderlyingSink<Uint8Array>,
    private requested: () => void,
  ) {
    super(sink, { highWaterMark: 1 });
  }
  override getWriter(): WritableStreamDefaultWriter<Uint8Array> {
    return new HalfCloseWriter(this, this.requested);
  }
}
