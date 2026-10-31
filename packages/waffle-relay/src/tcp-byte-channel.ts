import { OpenHeaderDecoder, TcpFailure } from "./tcp-protocol.js";

export interface ByteStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
export type ResetCode = 1 | 2 | 3 | 4;

export class ByteChannel {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private rest: Uint8Array | undefined;
  private cancellation: Promise<void> | undefined;
  constructor(
    stream: ByteStream,
    private resetReason: (code: ResetCode) => unknown,
    private readonly receiveWindow = 262144,
  ) {
    this.reader = stream.readable.getReader();
    this.writer = stream.writable.getWriter();
    void this.reader.closed.catch(() => {});
    void this.writer.closed.catch(() => {});
  }
  async read(): Promise<Uint8Array | undefined> {
    if (this.rest?.length) {
      const bytes = this.rest;
      this.rest = undefined;
      return bytes;
    }
    const next = await this.reader.read();
    if (next.done) return;
    if (
      !(next.value instanceof Uint8Array) ||
      next.value.buffer.byteLength > 8192 + 2 + 6 * this.receiveWindow + 32
    )
      throw new TcpFailure("protocol");
    return next.value;
  }
  get bufferedBytes(): number {
    return this.rest?.length ?? 0;
  }

  async header(maximum: number, allowPayload: boolean): Promise<string> {
    const decoder = new OpenHeaderDecoder(maximum);
    for (;;) {
      const bytes = await this.read();
      if (!bytes) throw new TcpFailure("protocol");
      const result = decoder.push(bytes);
      if (!result) continue;
      if (!allowPayload && result.rest.length) throw new TcpFailure("protocol");
      this.rest = result.rest;
      return result.header;
    }
  }
  reset(code: ResetCode): Promise<void> {
    this.cancellation ??= Promise.allSettled([
      this.reader.cancel(this.resetReason(code)),
      this.writer.abort(this.resetReason(code)),
    ]).then(async () => {
      await Promise.allSettled([this.reader.closed, this.writer.closed]);
    });
    return this.cancellation;
  }
  release(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.rest = undefined;
  }
}

export function browserResetReason(code: ResetCode): unknown {
  if (typeof WebTransportError === "function")
    return Reflect.construct(WebTransportError, [{ message: "TCP reset", streamErrorCode: code }]);
  return { streamErrorCode: code };
}
