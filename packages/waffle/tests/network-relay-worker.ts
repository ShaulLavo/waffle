/// <reference lib="webworker" />
import { NetHost } from "../browser/net/host.js";
import { AGAIN, ERROR, type NetRequest } from "../browser/net/protocol.js";
import type { RelayBrowserConfig } from "./network-relay-contract.js";

declare const self: DedicatedWorkerGlobalScope;
export type RelayGuestMessage =
  | { kind: "net"; request: NetRequest }
  | { kind: "pending" }
  | { kind: "result"; bytes: number }
  | { kind: "failure"; message: string };
export interface RelayGuestRequest {
  readonly kind: "traffic" | "hold";
  readonly ring: SharedArrayBuffer;
  readonly targets: RelayBrowserConfig["targets"];
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function progress(host: NetHost, operation: () => Uint8Array | number): Uint8Array | number {
  const until = performance.now() + 15000;
  for (;;) {
    const value = operation();
    if (value !== AGAIN) return value;
    check(performance.now() < until, "NetHost progress timed out");
    host.poll(100);
  }
}
function open(host: NetHost, target: { host: string; port: number }, first = false): number {
  const handle = host.connect(target.host, target.port);
  check(handle > 0, "NetHost did not allocate a connecting handle");
  check(
    host.write(handle, new Uint8Array()) === AGAIN,
    "Pending zero-length hostWrite must return AGAIN",
  );
  check(host.read(handle, 1) === AGAIN, "Pending hostRead must return AGAIN");
  if (first) self.postMessage({ kind: "pending" } satisfies RelayGuestMessage);
  check(
    progress(host, () => host.write(handle, new Uint8Array())) === 0,
    `NetHost connect failed ${host.error(handle)}`,
  );
  const peer: unknown = JSON.parse(String(host.peerAddr(handle)));
  check(
    peer && typeof peer === "object" && "address" in peer && peer.address === "127.0.0.1",
    "Guest did not receive the actual TCP peer",
  );
  return handle;
}
function send(host: NetHost, handle: number, bytes: Uint8Array): void {
  let at = 0;
  while (at < bytes.length) {
    const count = progress(host, () => host.write(handle, bytes.subarray(at)));
    check(typeof count === "number" && count > 0, `hostWrite failed ${host.error(handle)}`);
    at += count;
  }
}
function receive(host: NetHost, handle: number, expected: Uint8Array): void {
  let at = 0;
  while (at < expected.length) {
    const data = progress(host, () => host.read(handle, 257));
    check(data instanceof Uint8Array, `hostRead ended at ${at}: ${host.error(handle)}`);
    check(
      data.every((byte, index) => byte === expected[at + index]),
      `Payload differs at ${at}`,
    );
    at += data.length;
  }
  check(at === expected.length, "Target sent excess bytes");
  check(progress(host, () => host.read(handle, 1)) === 0, "Missing TCP half-close EOF");
}
function terminal(host: NetHost, handle: number, code: string): void {
  check(progress(host, () => host.read(handle, 64)) === ERROR, `Missing terminal ${code}`);
  check(
    String(host.error(handle)).includes(`"code":"${code}"`),
    `Wrong terminal error ${host.error(handle)}`,
  );
  check(host.write(handle, new Uint8Array()) === ERROR, "Terminal hostWrite became ready");
  check(host.close(handle) === 0, "Failed handle did not close");
}
function rejected(host: NetHost, target: { host: string; port: number }, code: string): void {
  const handle = host.connect(target.host, target.port);
  check(handle > 0, "Rejected connect did not start pending");
  check(host.write(handle, new Uint8Array()) === AGAIN, "Rejected connect skipped pending");
  check(
    progress(host, () => host.write(handle, new Uint8Array())) === ERROR,
    "Rejected connect became writable",
  );
  terminal(host, handle, code);
}
function run(request: RelayGuestRequest): void {
  const host = new NetHost(
    request.ring,
    (message, transfer = []) =>
      self.postMessage({ kind: "net", request: message } satisfies RelayGuestMessage, transfer),
    undefined,
    { shared: true },
  );
  let completed = false;
  try {
    const handle = open(host, request.targets.echo, true);
    if (request.kind === "hold") {
      completed = true;
      self.postMessage({ kind: "result", bytes: 0 } satisfies RelayGuestMessage);
      return;
    }
    const bytes = Uint8Array.from({ length: 98317 }, (_, index) => (index * 31 + 7) % 256);
    send(host, handle, bytes);
    check(host.shutdown(handle) === 0, "TCP write half-close failed");
    receive(host, handle, bytes);
    check(host.close(handle) === 0, "Echo handle did not close");
    const ssl = open(host, request.targets.ssl);
    const sslRequest = Uint8Array.of(0, 0, 0, 8, 4, 210, 22, 47);
    send(host, ssl, sslRequest.subarray(0, 3));
    send(host, ssl, sslRequest.subarray(3));
    check(host.shutdown(ssl) === 0, "SSLRequest shutdown failed");
    receive(host, ssl, Uint8Array.of(78));
    check(host.close(ssl) === 0, "SSLRequest handle did not close");
    rejected(host, request.targets.denied, "EACCES");
    rejected(host, request.targets.refused, "ECONNREFUSED");
    const reset = open(host, request.targets.echo);
    send(host, reset, new TextEncoder().encode("RE"));
    send(host, reset, new TextEncoder().encode("SET\n"));
    terminal(host, reset, "ECONNRESET");
    open(host, request.targets.echo);
    completed = true;
    self.postMessage({ kind: "result", bytes: bytes.length } satisfies RelayGuestMessage);
  } finally {
    if (!completed) host.dispose();
  }
}
self.onmessage = ({ data }: MessageEvent<RelayGuestRequest>) => {
  try {
    run(data);
  } catch (error) {
    self.postMessage({ kind: "failure", message: String(error) } satisfies RelayGuestMessage);
  }
};
