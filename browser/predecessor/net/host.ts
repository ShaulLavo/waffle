// Bun ABI adapters over the runtime's generic handles, rings and network state.
// Guest pointers, native names and slot installation stay on this side of the boundary.
import { memoryViews, type MemoryViews } from "@bun-wasm/runtime/core";
import { NetHost as RuntimeNetHost } from "@bun-wasm/runtime/browser/net/host";
import { type NetRequest, UNSUPPORTED } from "@bun-wasm/runtime/browser/net/protocol";
import { SLOT_NAMES, type SlotImpls } from "./trampoline";

/** What engine-host.js takes as `net` (see engine-host.d.ts). */
export interface EngineNet {
  natives: Record<string, (...args: never[]) => unknown>;
  caps: Record<string, boolean>;
  onNews(cb: () => void): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export class NetHost {
  private memory!: MemoryViews;
  private host: RuntimeNetHost;

  constructor(
    sab: SharedArrayBuffer,
    send: (msg: NetRequest, transfer?: Transferable[]) => void,
    writeFile?: (path: string, bytes: Uint8Array) => void,
  ) {
    this.host = new RuntimeNetHost(sab, send, writeFile);
  }

  attach(memory: WebAssembly.Memory): void {
    this.memory = memoryViews(memory);
  }

  /** Translate Bun's integer/pointer ABI into ordinary strings, bytes and handles. */
  slots(): SlotImpls {
    return {
      poll: (timeout) => this.host.poll(timeout),
      fetch: (metaPtr, metaLen, bodyPtr, bodyLen) => this.host.fetch(
        this.text(metaPtr, metaLen),
        bodyLen > 0 ? this.bytes(bodyPtr, bodyLen) : null,
      ),
      fetch_head: (handle, ptr, cap) => this.writeResult(this.host.fetchHead(handle), ptr, cap),
      read: (handle, ptr, cap) => {
        const chunk = this.host.read(handle, cap);
        if (typeof chunk === "number") return chunk;
        this.memory.bytes().set(chunk, ptr >>> 0);
        return chunk.length;
      },
      write: (handle, ptr, len) => this.host.write(handle, this.bytes(ptr, len)),
      close: (handle) => this.host.close(handle),
      listen: (hostPtr, hostLen, port) => this.host.listen(this.text(hostPtr, hostLen), port),
      local_port: (handle) => this.host.localPort(handle),
      accept: (listener) => this.host.accept(listener),
      connect: (hostPtr, hostLen, port) => this.host.connect(this.text(hostPtr, hostLen), port),
      error: (handle, ptr, cap) => this.writeResult(this.host.error(handle), ptr, cap),
      peer_addr: (handle, ptr, cap) => this.writeResult(this.host.peerAddr(handle), ptr, cap),
      shutdown: (handle) => this.host.shutdown(handle),
      local_addr: (handle, ptr, cap) => this.writeResult(this.host.localAddr(handle), ptr, cap),
    };
  }

  /** Browser-engine native names are Bun policy, not generic network-service names. */
  engineNet(): EngineNet {
    const text = (result: Uint8Array | number) => result instanceof Uint8Array ? decoder.decode(result) : result;
    return {
      natives: {
        hostPoll: () => UNSUPPORTED,
        hostFetch: (meta: string, body?: Uint8Array) => this.host.fetch(meta, body ?? null),
        hostFetchHead: (handle: number) => text(this.host.fetchHead(handle)),
        hostRead: (handle: number, cap = 65536) => this.host.read(handle, Math.max(1, cap)),
        hostWrite: (handle: number, bytes: Uint8Array) => this.host.write(handle, bytes),
        hostClose: (handle: number) => this.host.close(handle),
        hostListen: (host: string, port: number) => this.host.listen(host, port),
        hostLocalPort: (handle: number) => this.host.localPort(handle),
        hostAccept: (listener: number) => this.host.accept(listener),
        hostConnect: (host: string, port: number) => this.host.connect(host, port),
        hostError: (handle: number) => this.host.error(handle),
        hostPeerAddr: (handle: number) => this.host.peerAddr(handle),
        hostShutdown: (handle: number) => this.host.shutdown(handle),
        hostLocalAddr: (handle: number) => this.host.localAddr(handle),
      },
      caps: Object.fromEntries(SLOT_NAMES.map((name) => [name, name !== "poll" && name !== "signal"])),
      onNews: (cb) => this.host.onNews(cb),
    };
  }

  /** TextDecoder requires fixed, unshared storage even when guest memory can grow in place. */
  private text(ptr: number, len: number): string {
    return decoder.decode(new Uint8Array(this.bytes(ptr, len)));
  }

  /** Borrow guest bytes for this call only; the generic host copies any outgoing payload. */
  private bytes(ptr: number, len: number): Uint8Array {
    return this.memory.bytes().subarray(ptr >>> 0, (ptr >>> 0) + len);
  }

  /** Bun's sized-result protocol writes only when it fits, but always returns the full length. */
  private writeResult(result: Uint8Array | string | number, ptr: number, cap: number): number {
    if (typeof result === "number") return result;
    const data = typeof result === "string" ? encoder.encode(result) : result;
    if (data.length <= cap) this.memory.bytes().set(data, ptr >>> 0);
    return data.length;
  }
}
