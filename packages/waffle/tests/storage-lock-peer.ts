import { bounded } from "./page-runner/driver.js";
import assert from "node:assert/strict";
import { record, strings, type HostCase, type HostPeer } from "./page-runner/protocol.js";
import type { lockTest } from "./storage-lock-browser.js";
import type { StorageLockBackend } from "./storage-lock-cases.js";

type Fixture = typeof lockTest;
export async function invoke<K extends keyof Fixture>(
  peer: HostPeer,
  method: K,
  args: Parameters<Fixture[K]>,
): Promise<unknown> {
  const argumentsSource = args
    .map((value) => (value === undefined ? "undefined" : JSON.stringify(value)))
    .join(",");
  await peer.task(`const value = await window.lockTest[${JSON.stringify(method)}](${argumentsSource});
window.__lockAnswer = value === undefined ? {kind:'undefined'} : {kind:'value', value};`);
  const result = await peer.script("return window.__lockAnswer;");
  assert.ok(record(result), "Missing actual fixture answer");
  if (result.kind === "undefined") return undefined;
  assert.equal(result.kind, "value");
  assert.ok(Object.hasOwn(result, "value"), "Missing value differs from undefined");
  return result.value;
}
export async function object<K extends keyof Fixture>(
  peer: HostPeer,
  method: K,
  args: Parameters<Fixture[K]>,
): Promise<Record<string, unknown>> {
  const result = await invoke(peer, method, args);
  assert.ok(record(result), `Expected ${method} snapshot object`);
  return result;
}
export async function probes(peer: HostPeer): Promise<string[]> {
  const result = await invoke(peer, "probes", []);
  assert.ok(strings(result), "Expected actual Worker probes");
  return result;
}
export async function wait(host: HostCase, peer: HostPeer, expression: string): Promise<void> {
  const until = Math.min(performance.now() + 15_000, performance.now() + host.remainingMs());
  for (;;) {
    if (performance.now() >= until) throw new Error(`Storage-lock wait timed out: ${expression}`);
    const matched = await bounded(
      peer.script(`return Boolean(${expression});`),
      Math.max(1, until - performance.now()),
      "Storage-lock wait",
    );
    if (performance.now() >= until) throw new Error(`Storage-lock wait timed out: ${expression}`);
    if (matched) return;
    await host.sleep(10);
  }
}
export async function waitState(host: HostCase, peer: HostPeer, expected: string): Promise<void> {
  await wait(
    host,
    peer,
    `(() => { const current=window.lockTest.state().status; return current === ${JSON.stringify(expected)} || current === 'failed' || current === 'disposed' || ((${JSON.stringify(expected)} === 'waiting' || ${JSON.stringify(expected)} === 'failed') && current === 'ready'); })()`,
  );
  const current = await object(peer, "state", []);
  assert.equal(current.status, expected, `Expected ${expected}, got ${JSON.stringify(current)}`);
}
export async function ready(host: HostCase, peer: HostPeer, label: string): Promise<void> {
  await waitState(host, peer, "ready");
  assert.equal((await object(peer, "state", [])).status, "ready", `${label} was not ready`);
}
export async function waiting(host: HostCase, peer: HostPeer, label: string): Promise<void> {
  await waitState(host, peer, "waiting");
  const current = await object(peer, "state", []);
  assert.equal(current.status, "waiting", `${label} was not waiting`);
  assert.ok(!current.error, `${label} was not a clean waiting state`);
}
export function lockName(backend: StorageLockBackend, name: string): string {
  return backend === "indexeddb"
    ? `bun-wasm:filesystem:indexeddb:${name}`
    : `bun-wasm:filesystem:${name}`;
}
export async function query(peer: HostPeer): Promise<LockManagerSnapshot> {
  const value = await object(peer, "queryLocks", []);
  return { held: lockRows(value.held), pending: lockRows(value.pending) };
}
type LockManagerSnapshot = { held: Record<string, unknown>[]; pending: Record<string, unknown>[] };
function lockRows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value) && value.every(record), "Invalid real Web Locks snapshot");
  return value;
}
export async function waitProbe(host: HostCase, peer: HostPeer, probe: string): Promise<void> {
  await wait(host, peer, `window.lockTest.probes().includes(${JSON.stringify(probe)})`);
}
export class CasePeers {
  private readonly peers: HostPeer[] = [];
  private readonly closed = new Set<HostPeer>();
  constructor(
    readonly host: HostCase,
    readonly backend: StorageLockBackend,
    readonly name: string,
  ) {}
  async create(): Promise<HostPeer> {
    const peer = await this.host.openPeer();
    this.peers.push(peer);
    return peer;
  }
  async open(
    policy?: "wait" | "takeover",
    gated: boolean | "recovered" = false,
  ): Promise<HostPeer> {
    const peer = await this.create();
    await invoke(peer, "start", [this.backend, this.name, policy, gated]);
    return peer;
  }
  async close(peer: HostPeer): Promise<void> {
    if (this.closed.has(peer)) return;
    await peer.close();
    this.closed.add(peer);
  }
  async reload(peer: HostPeer): Promise<HostPeer> {
    const next = await peer.reload();
    this.closed.add(peer);
    this.peers.push(next);
    return next;
  }
  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const peer of this.peers) {
      try {
        await this.close(peer);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Exact peer cleanup failed");
  }
}
