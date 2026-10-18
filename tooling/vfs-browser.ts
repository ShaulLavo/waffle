import { SharedFilesystem } from "../browser/shared-fs.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import { OpfsStorage } from "../fs/opfs.js";
import type { ResolvedPath } from "../core/filesystem.js";
import { GuestIO, guestFixture } from "./vfs-guest.js";
import { w1Fixture, executeWorkload, executeSequentialRead, type WorkloadIO, type WorkloadResult } from "./vfs-workloads.js";
import type { Lane, Workload } from "./vfs-score-config.js";

export interface BrowserRequest { action: "seed" | "run" | "read" | "open" | "dispose" | "ownership"; backend: "indexeddb" | "opfs"; lane: Lane; workload: Workload; name: string; }
export interface BrowserResult extends WorkloadResult { ready?: boolean; ownershipLost?: boolean; }
class HostIO implements WorkloadIO {
  constructor(private fs: SharedFilesystem) {}
  private async handle(path: string, create = false): Promise<number> {
    const root = await this.fs.client.asyncCall("preopen", ["/"]);
    const resolved: ResolvedPath | number = await this.fs.client.asyncCall("resolve", [root, path.slice(1)]);
    if (typeof resolved === "number") throw Object.assign(new Error(`Host resolve errno ${resolved}`), { errno: resolved });
    let handle = resolved.node;
    if (handle === undefined && create) {
      const created = await this.fs.client.asyncCall("create", [resolved, "file", false]);
      if (typeof created !== "number") throw new Error(`Host create: ${JSON.stringify(created)}`); handle = created;
    }
    if (handle === undefined) throw new Error(`Missing host file ${path}`);
    return handle;
  }
  mkdir(path: string): Promise<void> { return this.fs.mkdirp(path); }
  async write(path: string, bytes: Uint8Array, offset?: number): Promise<void> {
    if (offset === undefined) return this.fs.writeFile(path, bytes);
    const handle = await this.handle(path, true); this.fs.client.retain(handle);
    try { const count = await this.fs.client.asyncCall("write", [handle, offset], bytes); if (count !== bytes.length) throw new Error("Short host write"); }
    finally { this.fs.client.release(handle); }
  }
  async read(path: string, offset?: number, size?: number): Promise<Uint8Array> {
    if (offset === undefined) { const bytes = await this.fs.readFile(path); if (!bytes) throw new Error(`Missing ${path}`); return bytes; }
    const handle = await this.handle(path); this.fs.client.retain(handle);
    try { const bytes = await this.fs.client.asyncCall("read", [handle, size, offset]); if (bytes.length !== size) throw new Error("Short host read"); return bytes; }
    finally { this.fs.client.release(handle); }
  }
  async stat(path: string): Promise<{ size: number }> { const handle = await this.handle(path); return this.fs.client.asyncCall("stat", [handle]); }
  async readdir(path: string): Promise<string[]> { const handle = await this.handle(path); const entries: { name: string }[] = await this.fs.client.asyncCall("readdir", [handle]); return entries.map(e => e.name).filter(name => name !== "." && name !== ".."); }
  async rename(from: string, to: string): Promise<void> { await this.fs.move(from, to); }
  async remove(path: string): Promise<void> { if (!await this.fs.remove(path)) throw new Error(`Missing removal ${path}`); }
  barrier(path?: string): Promise<void> { return this.fs.flush(path); }
}
let fs: SharedFilesystem | undefined;
// Compile the original Wasm fixture before readiness/first-use/workload clocks.
const guest = new WebAssembly.Module(guestFixture());
export async function request(input: BrowserRequest): Promise<BrowserResult> {
  const empty = (): BrowserResult => ({ metrics: {}, latencies: {}, acknowledgements: [], observations: {} });
  if (input.action === "seed") {
    const storage = input.backend === "indexeddb" ? await IndexedDBStorage.open(input.name) : await OpfsStorage.open(input.name);
    try { const batch = w1Fixture(); await storage.persist(batch); await storage.flush(); } finally { await storage.close(); }
    return empty();
  }
  if (input.action === "ownership") return { ...empty(), ownershipLost: fs?.ownershipLost ?? false };
  if (input.action === "dispose") { if (fs) { await fs.flush(); fs.dispose(); fs = undefined; } return empty(); }
  const start = performance.now();
  let readyAt = start;
  if (!fs) {
    fs = new SharedFilesystem({ workerURL: "/fs-worker.js", name: input.name, storage: input.backend }, stage => { if (stage === "filesystem-ready") readyAt = performance.now(); });
    await fs.resolvePath("/");
    // resolvePath orders after filesystem readiness, but does not hydrate payloads.
    readyAt = performance.now();
  }
  if (input.action === "open") return { ...empty(), ready: true, metrics: { readinessMs: performance.now() - start } };
  const facade = fs;
  const guestIO = input.lane === "guest" ? new GuestIO(facade.client, guest) : undefined;
  const io = guestIO ?? new HostIO(facade);
  // Namespace/global guest barriers include an explicit controller-owned global flush;
  // fd_sync(directory) itself promises targeted metadata, not all file payloads.
  if (guestIO) {
    const barrier = guestIO.barrier.bind(guestIO);
    guestIO.barrier = async path => { await barrier(path); if (path === undefined) await facade.flush(); };
  }
  let peak = facade.client.shared.resources().usedBytes;
  const measured = new Proxy(io, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== "function") return value;
    return async (...args: unknown[]) => { const result = await value.apply(target, args); peak = Math.max(peak, facade.client.shared.resources().usedBytes); return result; };
  } });
  try {
    const result = input.action === "read" ? { ...empty(), metrics: await executeSequentialRead(measured) }
      : await executeWorkload(input.workload, measured, (operation, elapsedMs) => globalThis.postMessage({ acknowledgement: { operation, elapsedMs } }));
    result.metrics.readinessMs = readyAt - start;
    result.metrics.peakResidentPayloadBytes = peak;
    result.observations = { ...result.observations, resident: facade.client.shared.resources(), hostLane: "SharedFilesystem facade; exposed async client RPC for offset IO/stat/readdir absent from whole-file facade", guestLane: "precompiled Wasm forwarding fixture -> preview1 -> FilesystemClient", namespaceBarrier: "guest directory fsync plus explicit global host flush", dirtyLag: "not exposed by current backends; not measured" };
    await facade.flush();
    return result;
  } finally { guestIO?.dispose(); }
}
if (typeof document === "undefined") {
  globalThis.onmessage = async (event: MessageEvent<BrowserRequest>) => {
    try { globalThis.postMessage({ result: await request(event.data) }); }
    catch (error) {
      const value = error as Error & { errno?: number; code?: string };
      globalThis.postMessage({ error: { message: `${value.name}: ${value.message}`, stack: value.stack, errno: value.errno, code: value.code } });
    }
  };
}
