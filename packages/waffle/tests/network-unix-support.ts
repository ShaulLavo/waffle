import { AGAIN } from "../browser/net/protocol.js";
import type { RuntimeNetworkHelper } from "../browser/net/runtime.js";
import type { GuestCall, GuestMessage } from "./network-unix-guest.js";

/** Workers and helpers the current test created; afterEach disposes them. */
export const live: { dispose(): void }[] = [];
export function disposeLive(): void {
  for (const item of live.splice(0).reverse()) item.dispose();
}

/** Drives a Worker-hosted guest NetHost by RPC; its NetRequests go to `helper`. */
export class Guest {
  private worker = new Worker(new URL("./network-unix-guest.ts", import.meta.url), {
    type: "module",
  });
  private calls = new Map<number, PromiseWithResolvers<unknown>>();
  private next = 0;
  lastMs = 0;
  constructor(
    readonly helper: RuntimeNetworkHelper,
    ring: SharedArrayBuffer,
  ) {
    this.worker.onmessage = ({ data }: MessageEvent<GuestMessage>) => {
      if (data.kind === "net") return this.helper.handle(data.request);
      const call = this.calls.get(data.id)!;
      this.calls.delete(data.id);
      if (data.kind === "throw") return call.reject(Error(data.message));
      this.lastMs = data.ms;
      call.resolve(data.value);
    };
    this.worker.postMessage({ kind: "start", ring });
    live.push({ dispose: () => this.worker.terminate() });
  }
  call<T = number>(method: GuestCall["method"], ...args: unknown[]): Promise<T> {
    const id = this.next++;
    const pending = Promise.withResolvers<unknown>();
    this.calls.set(id, pending);
    this.worker.postMessage({ kind: "call", id, method, args } satisfies GuestCall);
    return pending.promise as Promise<T>;
  }
  async error(handle = 0): Promise<{ code?: string; syscall?: string }> {
    return JSON.parse(await this.call<string>("error", handle));
  }
  async readAll(handle: number, size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = await this.call<Uint8Array | number>("read", handle, size - at);
      if (chunk === AGAIN) {
        await this.call("poll", 1000);
        continue;
      }
      if (typeof chunk === "number" || chunk.length === 0) throw Error(`read stopped: ${chunk}`);
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
  async accept(listener: number): Promise<number> {
    for (;;) {
      const conn = await this.call("accept", listener);
      if (conn !== AGAIN) return conn;
      await this.call("poll", 1000);
    }
  }
}

/** Reads until EOF (a zero read) or an error, polling the ring in between. */
export async function readEnd(guest: Guest, handle: number): Promise<number | Uint8Array> {
  for (;;) {
    const value = await guest.call<Uint8Array | number>("read", handle, 1 << 16);
    if (value !== AGAIN) return value;
    await guest.call("poll", 1000);
  }
}
