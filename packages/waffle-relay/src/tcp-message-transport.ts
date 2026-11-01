import {
  MAX_OPEN_BYTES,
  TcpFailure,
  frameCredit,
  frameData,
  parseFrame,
  type OpenReply,
  type TcpFrame,
} from "./tcp-protocol.js";
import type { FrameTransport, TcpFlow, CleanupBudget } from "./tcp-flow.js";
import type { ClientWebSocket } from "./tcp-websocket.js";
import type { ResetCode } from "./tcp-byte-channel.js";

export class MessageTransport implements FrameTransport {
  readonly kind = "websocket";
  readonly closed = Promise.withResolvers<void>();
  private readonly header = Promise.withResolvers<string>();
  private flow: TcpFlow | undefined;
  private first = true;
  private fault: (error: unknown) => void = () => {};
  private detach = () => {};
  private ended = false;
  private closeRequested = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private ws: ClientWebSocket,
    private onHeader?: (text: string) => void,
  ) {
    void this.header.promise.catch(() => {});
  }
  start(open: () => void = () => {}): void {
    this.detach = this.ws.listen({
      open,
      message: (data) => this.message(data),
      error: () => this.fault(new Error("carrier loss")),
      close: (code) => this.end(code),
    });
  }
  setFault(callback: (error: unknown) => void): void {
    this.fault = callback;
  }
  readHeader(): Promise<string> {
    return this.header.promise;
  }
  observeOpening(): void {}
  attach(flow: TcpFlow): void {
    this.flow = flow;
  }
  async handoffHeader(reply: OpenReply, handoff: () => void): Promise<void> {
    handoff();
    await this.ws.send(JSON.stringify(reply));
  }
  readFrames(): Promise<void> {
    return this.closed.promise;
  }
  async write(frame: TcpFrame, handoff: () => void): Promise<void> {
    const bytes =
      frame.kind === "data"
        ? frameData(frame.bytes)
        : frame.kind === "credit"
          ? frameCredit(frame.bytes)
          : Uint8Array.of(1);
    handoff();
    await this.ws.send(bytes);
  }
  finish(): Promise<void> {
    if (!this.ended) this.closeOnce(1000);
    return this.closed.promise;
  }
  protocolError(): void {
    this.closeOnce(1008);
  }
  reset(code: ResetCode, budget?: CleanupBudget): Promise<void> {
    if (this.ended) return this.closed.promise;
    this.closeOnce(4000 + code);
    let remaining = 5000;
    try {
      remaining = budget?.remaining() ?? 5000;
    } catch {
      remaining = 0;
    }
    if (this.ws.terminate) this.timer ??= setTimeout(() => this.ws.terminate!(), remaining);
    return this.closed.promise;
  }
  private closeOnce(code: number): void {
    if (this.closeRequested || this.ended) return;
    this.closeRequested = true;
    this.ws.close(code);
  }
  private message(value: unknown): void {
    try {
      if (this.first) {
        if (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_OPEN_BYTES)
          throw new TcpFailure("protocol");
        this.first = false;
        this.onHeader?.(value);
        this.header.resolve(value);
        return;
      }
      if (!this.flow) throw new TcpFailure("protocol");
      if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer))
        throw new TcpFailure("protocol");
      this.flow.receive(parseFrame(value instanceof Uint8Array ? value : new Uint8Array(value)));
    } catch (error) {
      this.closeOnce(1008);
      this.fault(error);
    }
  }
  private end(code: number): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.detach();
    if (code !== 1000 || !this.flow) {
      const error = new Error("TCP carrier ended");
      this.header.reject(error);
      this.fault(error);
    } else {
      try {
        this.flow.eof();
      } catch (error) {
        this.fault(error);
      }
    }
    this.closed.resolve();
  }
}
