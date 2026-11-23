import { PipeErrno, type PipeEndpoint } from "../proc/pipes.js";
import { ProcessError } from "../proc/types.js";
import { yieldTask } from "./yield-task.js";

const BATCH = 32;

export class CommandInput {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private closed = false;
  private readonly joined: Promise<void>;

  constructor(
    private readonly writer: PipeEndpoint,
    source: Uint8Array | ReadableStream<Uint8Array>,
    fail: (error: unknown) => void,
  ) {
    if (source instanceof ReadableStream) this.reader = source.getReader();
    this.joined = Promise.all([
      this.pump(source)
        .catch((error) => {
          if (!this.closed) fail(error);
        })
        .finally(() => this.close(false)),
      writer.waitReaderHangup().then(() => this.close()),
    ]).then(() => {});
    void this.joined.catch(fail);
  }

  stop(): Promise<void> {
    this.close();
    return this.joined;
  }

  private close(cancel = true): void {
    if (this.closed) return;
    this.closed = true;
    const reader = this.reader;
    this.reader = undefined;
    this.writer.close();
    if (!reader) return;
    const stream = this.stream;
    reader.releaseLock();
    if (cancel && stream) void stream.cancel().catch(() => {});
  }

  private stream?: ReadableStream<Uint8Array>;

  private async pump(source: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    if (source instanceof Uint8Array) {
      await this.write(source);
      return;
    }
    this.stream = source;
    let chunks = 0;
    while (this.reader && !this.closed) {
      const next = await this.reader.read();
      if (this.closed || next.done) return;
      if (!(next.value instanceof Uint8Array))
        throw new TypeError("Command stdin requires byte chunks");
      await this.write(next.value);
      if (++chunks % BATCH === 0) await yieldTask();
    }
  }

  private async write(bytes: Uint8Array): Promise<void> {
    let offset = 0,
      writes = 0;
    while (!this.closed && offset < bytes.length) {
      const accepted = this.writer.tryWrite([bytes.subarray(offset)]);
      if (accepted === -PipeErrno.PIPE) {
        this.close();
        return;
      }
      if (accepted === -PipeErrno.AGAIN) {
        await this.writer.waitWritable();
        continue;
      }
      if (accepted <= 0) throw new ProcessError(-accepted, "Command stdin write failed");
      offset += accepted;
      if (++writes % BATCH === 0) await yieldTask();
    }
  }
}
