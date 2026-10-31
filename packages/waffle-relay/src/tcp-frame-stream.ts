import {
  TcpFailure,
  frameCredit,
  encodeOpenHeader,
  type OpenReply,
  type TcpFrame,
} from "./tcp-protocol.js";
import type { TcpFlow, FrameTransport } from "./tcp-flow.js";
import { ByteChannel, type ByteStream, type ResetCode } from "./tcp-byte-channel.js";

export function encodeStreamFrame(frame: TcpFrame): Uint8Array<ArrayBuffer> {
  if (frame.kind === "credit") return frameCredit(frame.bytes);
  if (frame.kind === "fin") return Uint8Array.of(1);
  const bytes = new Uint8Array(frame.bytes.length + 5);
  new DataView(bytes.buffer).setUint32(1, frame.bytes.length);
  bytes.set(frame.bytes, 5);
  return bytes;
}
export class StreamFrameDecoder {
  private type: number | undefined;
  private prefix = new Uint8Array(4);
  private prefixBytes = 0;
  private remaining = 0;
  constructor(private flow: Pick<TcpFlow, "startData" | "data" | "receive">) {}
  push(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.remaining) {
        const size = Math.min(this.remaining, bytes.length - offset);
        this.flow.data(bytes.subarray(offset, offset + size));
        offset += size;
        this.remaining -= size;
        continue;
      }
      if (this.type === undefined) {
        this.type = bytes[offset++]!;
        if (this.begin()) continue;
      }
      const size = Math.min(4 - this.prefixBytes, bytes.length - offset);
      this.prefix.set(bytes.subarray(offset, offset + size), this.prefixBytes);
      this.prefixBytes += size;
      offset += size;
      if (this.prefixBytes === 4) this.header();
    }
  }
  eof(): void {
    if (this.type !== undefined || this.remaining || this.prefixBytes)
      throw new TcpFailure("protocol");
  }
  private begin(): boolean {
    if (this.type === 1) {
      this.flow.receive({ kind: "fin" });
      this.type = undefined;
      return true;
    }
    if (this.type !== 0 && this.type !== 2) throw new TcpFailure("protocol");
    return false;
  }
  private header(): void {
    const size = new DataView(this.prefix.buffer).getUint32(0);
    if (this.type === 0) {
      this.flow.startData(size);
      this.remaining = size;
    } else this.flow.receive({ kind: "credit", bytes: size });
    this.type = undefined;
    this.prefixBytes = 0;
  }
}
export class StreamTransport implements FrameTransport {
  readonly kind = "webtransport";
  readonly channel: ByteChannel;
  readonly inputEnded = Promise.withResolvers<void>();
  private closing: Promise<void> | undefined;
  private finished = false;
  private opened = false;
  private fault: (error: unknown) => void = () => {};
  private firstInput: Promise<Uint8Array | undefined> | undefined;
  private resetReceipt: Promise<void> | undefined;
  constructor(
    stream: ByteStream,
    receiveWindow: number,
    resetReason: (code: ResetCode) => unknown,
    private sessionClosed?: Promise<unknown>,
  ) {
    this.channel = new ByteChannel(stream, resetReason, receiveWindow);
    void this.inputEnded.promise.catch(() => {});
  }
  setFault(callback: (error: unknown) => void): void {
    this.fault = callback;
  }
  readHeader(maximum: number): Promise<string> {
    return this.channel.header(maximum, false);
  }
  observeOpening(): void {
    this.firstInput = this.channel.read().then((bytes) => {
      if (!this.opened) {
        const error = new TcpFailure("protocol");
        this.fault(error);
        throw error;
      }
      return bytes;
    });
    void this.firstInput.catch(() => {});
  }
  attach(_flow: TcpFlow): void {}
  handoffHeader(reply: OpenReply, handoff: () => void): Promise<void> {
    this.opened = true;
    handoff();
    return this.channel.writer.write(encodeOpenHeader(reply));
  }
  async write(frame: TcpFrame, handoff: () => void): Promise<void> {
    const bytes = encodeStreamFrame(frame);
    handoff();
    await this.channel.writer.write(bytes);
  }
  finish(): Promise<void> {
    this.closing ??= Promise.all([this.channel.writer.close(), this.inputEnded.promise]).then(
      () => {
        this.finished = true;
        this.channel.release();
      },
    );
    return this.closing;
  }
  reset(code: ResetCode, _budget?: import("./tcp-flow.js").CleanupBudget): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.resetReceipt ??= this.cancel(code);
    return this.resetReceipt;
  }
  private async cancel(code: ResetCode): Promise<void> {
    const resetting = this.channel.reset(code);
    if (this.sessionClosed) await Promise.race([resetting, this.sessionClosed.catch(() => {})]);
    else await resetting;
    this.channel.release();
  }
  async readFrames(flow: TcpFlow, first?: Promise<Uint8Array | undefined>): Promise<void> {
    const decoder = new StreamFrameDecoder(flow);
    try {
      let pending = first ?? this.firstInput;
      for (;;) {
        const bytes = await (pending ?? this.channel.read());
        pending = undefined;
        if (!bytes) break;
        decoder.push(bytes);
      }
      decoder.eof();
      flow.eof();
      this.inputEnded.resolve();
    } catch (error) {
      this.inputEnded.reject(error);
      void flow.reset(error, 3);
      throw error;
    }
  }
}
