import { Kind, AGAIN, MAX_RECORD, type NetError, type PeerAddr } from "./protocol.js";
import { TCP_PIPE, TCP_RESET } from "./tcp-status.js";
import { isPeerAddr } from "./address.js";
import type { NetConnect, NetOutboundStream, NetOutboundTarget } from "./outbound.js";
import type { RingWriter } from "./ring.js";

const WINDOW = 1 << 20;
const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));
const ignore = () => {};

type OpenStream = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  finishWrite?: Promise<void>;
};
type State =
  | { kind: "connecting" }
  | { kind: "opening" | "open" | "closing"; io: OpenStream }
  | { kind: "failed" }
  | { kind: "closed" };

/** Page-owned Web Streams adapter. Credit counts bytes until the guest reads or the sink settles. */
export class OutboundSocket {
  private state: State = { kind: "connecting" };
  private readonly controller = new AbortController();
  private inbound = 0;
  private wake: (() => void) | undefined;
  private queued = 0;
  private blocked = false;
  private writeEnded = false;

  constructor(
    private readonly id: number,
    private readonly target: NetOutboundTarget,
    private readonly ring: RingWriter,
    private readonly release: () => void,
  ) {}

  start(connect: NetConnect): void {
    void this.open(connect).catch((error) => this.fail(error));
  }

  private async open(connect: NetConnect): Promise<void> {
    // Publish the synchronous pending reply before invoking page code.
    await Promise.resolve();
    if (this.state.kind !== "connecting") return;
    const stream = await connect(Object.freeze({ ...this.target }), this.controller.signal);
    if (this.state.kind !== "connecting") {
      resetStream(stream);
      return;
    }
    const peer = { ...stream.remote };
    if (!isPeerAddr(peer)) {
      resetStream(stream);
      throw new TypeError("Outbound connector returned an invalid remote address");
    }
    const reader = stream.readable.getReader();
    let writer: WritableStreamDefaultWriter<Uint8Array>;
    try {
      writer = stream.writable.getWriter();
    } catch (error) {
      void reader.cancel(error).catch(ignore);
      reader.releaseLock();
      throw error;
    }
    const io: OpenStream = { reader, writer };
    this.state = { kind: "opening", io };
    const local: PeerAddr = {
      address: peer.family === "IPv6" ? "::" : "0.0.0.0",
      family: peer.family,
      port: 0,
    };
    await this.ring.write(this.id, Kind.Open, json({ local, peer }));
    if (this.state.kind !== "opening") return;
    this.state = { kind: "open", io };
    if (this.writeEnded) void this.finishWrite(io).catch((error) => this.fail(error));
    void this.read(io).catch((error) => this.fail(error));
  }

  private async read(io: OpenStream): Promise<void> {
    while (this.state.kind === "open") {
      await this.credit();
      if (this.state.kind !== "open") return;
      const { done, value } = await io.reader.read();
      if (this.state.kind !== "open") return;
      if (done) {
        await this.ring.write(this.id, Kind.End);
        return;
      }
      await this.deliver(value);
    }
  }

  private async deliver(bytes: Uint8Array): Promise<void> {
    for (let at = 0; at < bytes.length;) {
      await this.credit();
      if (this.state.kind !== "open") return;
      const count = Math.min(MAX_RECORD, WINDOW - this.inbound, bytes.length - at);
      this.inbound += count;
      await this.ring.write(this.id, Kind.Data, bytes.subarray(at, at + count));
      at += count;
    }
  }

  private async credit(): Promise<void> {
    while (this.state.kind === "open" && this.inbound >= WINDOW)
      await new Promise<void>((resolve) => (this.wake = resolve));
  }

  consumed(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.inbound) return;
    this.inbound -= bytes;
    this.wakeReader();
  }

  writableNow(): boolean {
    return this.state.kind === "open" && !this.writeEnded && this.queued < WINDOW;
  }

  write(bytes: Uint8Array): number {
    const state = this.state;
    if (state.kind === "connecting" || state.kind === "opening") return AGAIN;
    if (state.kind === "failed") return TCP_RESET;
    if (state.kind !== "open" || this.writeEnded) return TCP_PIPE;
    const count = Math.min(bytes.length, WINDOW - this.queued);
    if (count === 0 && bytes.length > 0) {
      this.blocked = true;
      return AGAIN;
    }
    if (count === 0) return 0;
    this.queued += count;
    // Full requests are transport-owned. A partial view would retain the rejected backing bytes.
    const accepted = count === bytes.length ? bytes : bytes.slice(0, count);
    void state.io.writer.write(accepted).then(
      () => this.settled(count),
      (error) => this.fail(error),
    );
    if (this.queued === WINDOW) this.blocked = true;
    return count;
  }

  private settled(bytes: number): void {
    this.queued -= bytes;
    if (this.state.kind !== "open" || !this.blocked || this.writeEnded) return;
    this.blocked = false;
    void this.ring.write(this.id, Kind.Writable);
  }

  shutdown(): void {
    if (this.writeEnded) return;
    this.writeEnded = true;
    if (this.state.kind === "open")
      void this.finishWrite(this.state.io).catch((error) => this.fail(error));
  }

  private finishWrite(io: OpenStream): Promise<void> {
    io.finishWrite ??= io.writer.close();
    return io.finishWrite;
  }

  /** Guest close drains accepted writes without aborting an established connector. */
  close(): void {
    const state = this.state;
    if (state.kind === "closed" || state.kind === "closing") return;
    if (state.kind === "connecting" || state.kind === "opening" || state.kind === "failed")
      return this.reset();
    this.state = { kind: "closing", io: state.io };
    this.writeEnded = true;
    this.wakeReader();
    void this.drainClose(state.io);
  }

  private async drainClose(io: OpenStream): Promise<void> {
    await Promise.allSettled([this.finishWrite(io), io.reader.cancel()]);
    if (this.state.kind !== "closing") return;
    this.state = { kind: "closed" };
    releaseLocks(io);
    this.release();
  }

  /** Worker exit resets immediately, including a guest close still draining. */
  reset(): void {
    if (this.state.kind === "closed") return;
    this.stopIO();
    this.release();
  }

  private stopIO(): void {
    const state = this.state;
    this.state = { kind: "closed" };
    this.wakeReader();
    this.controller.abort();
    if (state.kind !== "open" && state.kind !== "opening" && state.kind !== "closing") return;
    const { reader, writer } = state.io;
    void Promise.allSettled([writer.abort(), reader.cancel()]).then(() => releaseLocks(state.io));
  }

  private wakeReader(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private fail(error: unknown): void {
    if (
      this.state.kind === "closed" ||
      this.state.kind === "closing" ||
      this.state.kind === "failed"
    )
      return;
    const opened = this.state.kind === "open";
    const failure = connectError(error, this.target, opened);
    this.stopIO();
    // Retain a terminal handle until guest close so synchronous writes cannot lose the error.
    this.state = { kind: "failed" };
    void this.ring.write(this.id, Kind.Error, json(failure));
  }
}

function releaseLocks(io: OpenStream): void {
  io.reader.releaseLock();
  io.writer.releaseLock();
}

function resetStream(stream: NetOutboundStream): void {
  void stream.readable.cancel().catch(ignore);
  void stream.writable.abort().catch(ignore);
}

const CODES = new Set([
  "EACCES",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
]);

function connectError(error: unknown, target: NetOutboundTarget, opened: boolean): NetError {
  const code = !opened && error instanceof Error && "code" in error ? error.code : undefined;
  const mapped = typeof code === "string" && CODES.has(code) ? code : "ECONNRESET";
  return {
    name: "Error",
    message: `${opened ? "socket" : "connect"} ${mapped} ${target.host}:${target.port}`,
    code: mapped,
    syscall: opened ? "read" : "connect",
    hostname: target.host,
    address: target.host,
    port: target.port,
  };
}
