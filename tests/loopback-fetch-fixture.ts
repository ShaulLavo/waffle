import { afterEach, expect } from "bun:test";
import { NetHelper, NetNamespace, type NetFetch } from "../browser/net/helper.js";
import { AGAIN } from "../browser/net/protocol.js";
import { createRing } from "../browser/net/ring.js";
import type { FetchCommand, FetchMessage } from "./loopback-fetch-worker.js";

const teardown = new Set<() => void>();
afterEach(() => {
  for (const close of teardown) close();
});
export const encode = (text: string) => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export function peer(
  namespace: NetNamespace,
  fetchRequest: NetFetch = async () => {
    throw Error("Outbound denied");
  },
) {
  const ring = createRing();
  const helper = new NetHelper(ring, fetchRequest, {}, namespace);
  const worker = new Worker(new URL("./loopback-fetch-worker.ts", import.meta.url), {
    type: "module",
  });
  const ready = Promise.withResolvers<void>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  let next = 0;
  worker.onmessage = ({ data }: MessageEvent<FetchMessage>) => {
    if (data.kind === "ready") return ready.resolve();
    if (data.kind === "net") return helper.handle(data.request);
    const call = pending.get(data.id);
    pending.delete(data.id);
    if (data.kind === "error") call?.reject(Error(data.message));
    else call?.resolve(data.value);
  };
  worker.onerror = (event) => ready.reject(Error(event.message));
  const close = () => {
    teardown.delete(close);
    worker.terminate();
    helper.dispose();
  };
  teardown.add(close);
  worker.postMessage({ ring });
  return {
    ready: ready.promise,
    close,
    call(command: FetchCommand) {
      const call = Promise.withResolvers<unknown>();
      const id = ++next;
      pending.set(id, call);
      worker.postMessage({ id, command });
      return call.promise;
    },
  };
}
export type Peer = ReturnType<typeof peer>;
export async function handle(peer: Peer, command: FetchCommand): Promise<number> {
  const value = await peer.call(command);
  if (typeof value !== "number") throw Error("Expected handle");
  return value;
}
export async function settled(peer: Peer, command: FetchCommand): Promise<unknown> {
  for (let i = 0; i < 1000; i++) {
    const value = await peer.call(command);
    if (value !== AGAIN) return value;
    await Bun.sleep(1);
  }
  throw Error("Timed out awaiting network result");
}
export async function head(peer: Peer, handle: number) {
  const value = await settled(peer, { op: "head", handle });
  if (typeof value === "number") return value;
  if (!(value instanceof Uint8Array)) throw Error("Expected head bytes");
  const parsed: unknown = JSON.parse(decode(value));
  return parsed;
}
export async function body(peer: Peer, handle: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await settled(peer, { op: "read", handle, cap: 65536 });
    if (chunk === 0) break;
    if (!(chunk instanceof Uint8Array))
      throw Error(`Body failed: ${await peer.call({ op: "error", handle })}`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
export function response(status: number, headers: string, text = "") {
  return encode(
    `HTTP/1.1 ${status} Test\r\n${headers}Content-Length: ${encode(text).length}\r\n\r\n${text}`,
  );
}
export async function pair(fetchRequest?: NetFetch) {
  const namespace = new NetNamespace();
  const server = peer(namespace);
  const client = peer(namespace, fetchRequest);
  await Promise.all([server.ready, client.ready]);
  const listener = await handle(server, { op: "listen", port: 32216 });
  expect(listener).toBeGreaterThan(0);
  return { server, client, listener, url: "http://localhost:32216" };
}
