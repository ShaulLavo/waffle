import { guardedStream } from "./guarded-stream.js";
import {
  RIGHT_FD_READ,
  RIGHT_FD_WRITE,
  RIGHT_FD_FDSTAT_SET_FLAGS,
  RIGHT_FD_FILESTAT_GET,
  RIGHT_POLL_FD_READWRITE,
  RIGHT_SOCK_SHUTDOWN,
} from "../core/rights.js";
import type { DescriptorTable, Readiness, Stream } from "../core/descriptors.js";
import { NetHost } from "./net/host.js";
import { AGAIN, BADF, type NetRequest } from "./net/protocol.js";
import type { Preview1NetworkConnection } from "./preview1-network-types.js";
import {
  reflectApply,
  typedArrayLength,
  typedArraySet,
  typedArraySubarray,
  atomicsLoad,
  Uint8ArrayConstructor,
} from "../proc/intrinsics.js";

const EAGAIN = 6;
const EPIPE = 64;
const codes: Record<string, number> = {
  EACCES: 2,
  EBADF: 8,
  ECANCELED: 11,
  ECONNREFUSED: 14,
  ECONNRESET: 15,
  ENOTFOUND: 23,
  EHOSTUNREACH: 23,
  EINVAL: 28,
  EIO: 29,
  ENETUNREACH: 40,
  ENOTCONN: 53,
  ENOTSUP: 58,
  EPIPE,
  ETIMEDOUT: 73,
};
const errno = (code: string | undefined) => codes[code ?? "EIO"] ?? 29;
const empty = new Uint8ArrayConstructor(0);
function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return;
  return typeof value.code === "string" ? value.code : undefined;
}

/** One descriptor description. Duplicated fds share this handle, flags and close lifetime. */
class SocketStream implements Stream {
  readonly kind = "socket";
  fdflags = 0;
  private closed = false;
  private writeEnded = false;
  private writeFailed = false;
  constructor(
    private readonly host: NetHost,
    private readonly handle: number,
    private readonly initialError: number,
    private readonly checkActive: () => void,
    private readonly wait: (word: Int32Array, expected: number) => void,
  ) {}
  get notification(): Int32Array {
    return this.host.notification;
  }
  readiness(): Readiness {
    this.checkActive();
    if (this.closed || this.initialError)
      return {
        readable: true,
        writable: true,
        hangup: true,
        nbytes: 0,
        error: this.initialError || 8,
      };
    const state = this.host.socketState(this.handle);
    return { ...state, error: state.error ? errno(state.error) : undefined };
  }
  private result(result: number): number {
    if (result >= 0) return result;
    if (result === AGAIN) return -EAGAIN;
    if (result === BADF) return -8;
    return -errno(this.host.socketState(this.handle).error);
  }
  private io(operation: () => number, blocking: boolean): number {
    for (;;) {
      this.checkActive();
      const word = this.notification;
      const observed = atomicsLoad(word, 0);
      const result = operation();
      if (result !== -EAGAIN || !blocking) return result;
      this.wait(word, observed);
    }
  }
  tryRead(chunks: readonly Uint8Array[]): number {
    if (this.closed) return -8;
    if (this.initialError) return -this.initialError;
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const length = typedArrayLength(chunk);
      if (!length) continue;
      const data = this.host.read(this.handle, length);
      if (typeof data === "number") return total || this.result(data);
      typedArraySet(chunk, data);
      total += typedArrayLength(data);
      if (typedArrayLength(data) < length) break;
    }
    return total;
  }
  read(chunks: readonly Uint8Array[]): number {
    return this.recv(chunks, false);
  }
  recv(chunks: readonly Uint8Array[], waitall: boolean): number {
    const blocking = !(this.fdflags & 4);
    if (!waitall) return this.io(() => this.tryRead(chunks), blocking);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const count = this.readAll(chunks[i]!, blocking);
      if (count < 0) return total || count;
      total += count;
      if (count < typedArrayLength(chunks[i]!)) break;
    }
    return total;
  }
  private readAll(chunk: Uint8Array, blocking: boolean): number {
    let total = 0;
    while (total < typedArrayLength(chunk)) {
      const remaining = typedArraySubarray(chunk, total);
      const count = this.io(() => this.tryRead([remaining]), blocking);
      if (count <= 0) return total || count;
      total += count;
    }
    return total;
  }
  tryWrite(chunks: readonly Uint8Array[]): number {
    if (this.closed || this.writeEnded || this.writeFailed) return -EPIPE;
    if (this.initialError) {
      this.writeFailed = true;
      return -this.initialError;
    }
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (!typedArrayLength(chunk)) continue;
      const count = this.writeOne(chunk);
      if (count < 0) return total || this.reportWrite(count);
      total += count;
      if (count < typedArrayLength(chunk)) break;
    }
    if (total === 0) return this.reportWrite(this.writeOne(empty));
    return total;
  }
  private writeOne(chunk: Uint8Array): number {
    return this.result(this.host.write(this.handle, chunk));
  }
  private reportWrite(result: number): number {
    if (result < 0 && result !== -EAGAIN) this.writeFailed = true;
    return result;
  }
  write(chunks: readonly Uint8Array[]): number {
    return this.io(() => this.tryWrite(chunks), true);
  }
  shutdown(how: number): number {
    this.checkActive();
    if (this.closed) return -8;
    if (this.initialError) return -this.initialError;
    if (how & 1) this.host.shutdownRead(this.handle);
    if (how & 2) {
      this.writeEnded = true;
      this.host.shutdown(this.handle);
    }
    return 0;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handle > 0) this.host.close(this.handle);
  }
}

/** Runs only in the receiving worker before instantiation. The port sends requests, never secrets. */
export function attachPreview1Sockets(
  connection: Preview1NetworkConnection,
  checkActive: () => void,
  wait: (word: Int32Array, expected: number) => void,
) {
  const port = connection.port;
  const send = port.postMessage;
  const close = port.close;
  const host = new NetHost(
    connection.ring,
    (request: NetRequest, transfer?: Transferable[]) => {
      reflectApply(send, port, [request, transfer ?? []]);
    },
    undefined,
    { shared: true },
  );
  return {
    install(descriptors: DescriptorTable, checkIoActive: () => void) {
      const rights =
        RIGHT_FD_READ |
        RIGHT_FD_WRITE |
        RIGHT_FD_FDSTAT_SET_FLAGS |
        RIGHT_FD_FILESTAT_GET |
        RIGHT_POLL_FD_READWRITE |
        RIGHT_SOCK_SHUTDOWN;
      for (let i = 0; i < connection.sockets.length; i++) {
        checkActive();
        const binding = connection.sockets[i]!;
        const target = binding.socket.connect;
        const handle = host.connect(target.host, target.port);
        const failure = handle < 0 ? errno(errorCode(JSON.parse(String(host.error(0))))) : 0;
        const stream = new SocketStream(host, handle, failure, checkActive, wait);
        descriptors.close(binding.fd);
        descriptors.openAt(binding.fd, guardedStream(stream, checkIoActive), rights, 0n);
      }
    },
    dispose() {
      try {
        host.dispose();
      } finally {
        reflectApply(close, port, []);
      }
    },
  };
}
