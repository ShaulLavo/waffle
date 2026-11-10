// WIR framing reuses the owned-page diagnostic's original bounded binary-plist codec.
// Protocol keys follow appium-remote-debugger cb98aa87 and WebKit 4c54bb31, not a second browser owner.
import { createConnection, type Socket } from "node:net";
import { Frames, frame, isDict, type PlistDict } from "./inspector-plist.js";
import { HostConsumers } from "./owned-consumers.js";
import { bounded } from "./driver.js";

export type InspectorEnvelope = { sequence: number; selector: string; argument: PlistDict };
export interface InspectorTransport {
  send(selector: string, argument: PlistDict): Promise<void>;
  close(): Promise<void>;
}
export function inspectorEnvelope(value: unknown, sequence: number): InspectorEnvelope {
  if (
    !isDict(value) ||
    typeof value.__selector !== "string" ||
    !value.__selector ||
    value.__selector.length > 256
  )
    throw new Error("Invalid WIR envelope selector");
  const argument = value.__argument ?? {};
  if (!isDict(argument)) throw new Error("Invalid WIR envelope argument");
  return { sequence, selector: value.__selector, argument };
}
export class InspectorStream implements InspectorTransport {
  private readonly frames = new Frames();
  private sequence = 0;
  private bytes = 0;
  private sent = 0;
  private failed = false;
  private closing: Promise<void> | undefined;
  private readonly closed: Promise<void>;
  private constructor(
    private readonly socket: Socket,
    private readonly consumers: HostConsumers,
    private readonly accept: (envelope: InspectorEnvelope) => void,
    private readonly lost: (error: unknown) => void,
  ) {
    this.closed = new Promise((resolve) => socket.once("close", resolve));
    socket.on("data", (chunk) => this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("error", (error) => this.fail(error));
    socket.on("end", () =>
      this.fail(new Error(`Inspector EOF, frame boundary ${this.frames.atBoundary()}`)),
    );
    socket.on("close", () => {
      if (!this.closing) this.fail(new Error("Inspector socket lost"));
    });
  }
  static async connect(
    path: string,
    consumers: HostConsumers,
    accept: (envelope: InspectorEnvelope) => void,
    lost: (error: unknown) => void,
  ): Promise<InspectorStream> {
    const socket = createConnection({ path });
    const ready = new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    try {
      await bounded(ready, 3000, "Inspector connect");
      return new InspectorStream(socket, consumers, accept, lost);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  send(selector: string, argument: PlistDict): Promise<void> {
    return this.consumers.invoke(() => {
      if (this.failed || this.closing) throw new Error("Inspector stream unavailable");
      if (++this.sent > 65_536) throw new Error("Inspector outbound bound exceeded");
      const bytes = frame({ __selector: selector, __argument: argument });
      return new Promise<void>((resolve, reject) => {
        this.socket.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    });
  }
  private receive(chunk: Buffer): void {
    if (this.failed) return;
    try {
      this.bytes += chunk.length;
      if (this.bytes > 64 << 20) throw new Error("Inspector inbound bound exceeded");
      this.frames.feed(chunk, (value) => this.accept(inspectorEnvelope(value, ++this.sequence)));
    } catch (error) {
      this.fail(error);
    }
  }
  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.lost(error);
    this.socket.destroy();
  }
  close(): Promise<void> {
    return (this.closing ??= this.consumers.invoke(async () => {
      this.socket.end();
      try {
        await bounded(this.closed, 2000, "Inspector socket close");
      } finally {
        this.socket.destroy();
      }
    }));
  }
}
