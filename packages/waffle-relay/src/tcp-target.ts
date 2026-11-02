import { Socket } from "node:net";
import { MAX_DATA_BYTES, type TcpTarget } from "./tcp-protocol.js";

/** A single fixed onread buffer. The caller must consume a read before requesting the next. */
export class TcpTargetSocket {
  readonly connected: Promise<void>;
  readonly closed: Promise<void>;
  private readonly socket: Socket;
  private next = Promise.withResolvers<Uint8Array | undefined>();
  private eof = false;
  private error: Error | undefined;
  constructor(target: TcpTarget) {
    const connected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    this.connected = connected.promise;
    this.closed = closed.promise;
    void this.connected.catch(() => {});
    this.socket = new Socket({
      allowHalfOpen: true,
      onread: {
        buffer: new Uint8Array(MAX_DATA_BYTES),
        callback: (length: number, buffer: Uint8Array) => {
          this.next.resolve(buffer.subarray(0, length));
          return false;
        },
      },
    });
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true, 60000);
    this.socket.on("error", (error) => {
      this.error = error;
      connected.reject(error);
      this.next.reject(error);
    });
    this.socket.once("end", () => {
      this.eof = true;
      this.next.resolve(undefined);
    });
    this.socket.once("close", () => {
      this.next.resolve(undefined);
      closed.resolve();
    });
    void this.next.promise.catch(() => {});
    this.socket.connect({ host: target.host, port: target.port }, () => connected.resolve());
  }
  async read(): Promise<Uint8Array | undefined> {
    if (this.error) throw this.error;
    if (this.eof) return;
    this.socket.resume();
    const value = await this.next.promise;
    this.next = Promise.withResolvers<Uint8Array | undefined>();
    void this.next.promise.catch(() => {});
    return value;
  }
  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  }
  end(): Promise<void> {
    return new Promise((resolve) => this.socket.end(resolve));
  }
  close(): Promise<void> {
    this.socket.destroy();
    return this.closed;
  }
}
