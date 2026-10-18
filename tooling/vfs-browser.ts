import { indexeddbStartupIntervals } from "./vfs-startup.js";
import type { RuntimeStartupStage } from "../fs/startup.js";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import { OpfsStorage } from "../fs/opfs.js";
import type { ResolvedPath } from "../core/filesystem.js";
import { GuestIO, guestFixture } from "./vfs-guest.js";
import {
  content,
  verify,
  w1Fixture,
  executeWorkload,
  executeSequentialRead,
  type WorkloadIO,
  type WorkloadResult,
} from "./vfs-workloads.js";
import type { Lane, Workload } from "./vfs-score-config.js";

export interface BrowserRequest {
  action:
    | "seed"
    | "delete-empty"
    | "run"
    | "read"
    | "open"
    | "start"
    | "dispose"
    | "ownership"
    | "await-revocation"
    | "marker"
    | "probe"
    | "fence";
  backend: "indexeddb" | "opfs";
  lane: Lane;
  workload: Workload;
  name: string;
  whenBusy?: "wait";
}
export interface BrowserResult extends WorkloadResult {
  ready?: boolean;
  ownershipLost?: boolean;
  status?: string;
}
class HostIO implements WorkloadIO {
  constructor(private fs: SharedFilesystem) {}
  private async handle(path: string, create = false): Promise<number> {
    const root = await this.fs.client.asyncCall("preopen", ["/"]);
    const resolved: ResolvedPath | number = await this.fs.client.asyncCall("resolve", [
      root,
      path.slice(1),
    ]);
    if (typeof resolved === "number")
      throw Object.assign(new Error(`Host resolve errno ${resolved}`), { errno: resolved });
    let handle = resolved.node;
    if (handle === undefined && create) {
      const created = await this.fs.client.asyncCall("create", [resolved, "file", false]);
      if (typeof created !== "number") throw new Error(`Host create: ${JSON.stringify(created)}`);
      handle = created;
    }
    if (handle === undefined) throw new Error(`Missing host file ${path}`);
    return handle;
  }
  mkdir(path: string): Promise<void> {
    return this.fs.mkdirp(path);
  }
  async write(path: string, bytes: Uint8Array, offset?: number): Promise<void> {
    if (offset === undefined) return this.fs.writeFile(path, bytes);
    const handle = await this.handle(path, true);
    this.fs.client.retain(handle);
    try {
      const count = await this.fs.client.asyncCall("write", [handle, offset], bytes);
      if (count !== bytes.length) throw new Error("Short host write");
    } finally {
      this.fs.client.release(handle);
    }
  }
  async read(path: string, offset?: number, size?: number): Promise<Uint8Array> {
    if (offset === undefined) {
      const bytes = await this.fs.readFile(path);
      if (!bytes) throw new Error(`Missing ${path}`);
      return bytes;
    }
    const handle = await this.handle(path);
    this.fs.client.retain(handle);
    try {
      const bytes = await this.fs.client.asyncCall("read", [handle, size, offset]);
      if (bytes.length !== size) throw new Error("Short host read");
      return bytes;
    } finally {
      this.fs.client.release(handle);
    }
  }
  async stat(path: string): Promise<{ size: number }> {
    const handle = await this.handle(path);
    return this.fs.client.asyncCall("stat", [handle]);
  }
  async readdir(path: string): Promise<string[]> {
    const handle = await this.handle(path);
    const entries: { name: string }[] = await this.fs.client.asyncCall("readdir", [handle]);
    return entries.map((e) => e.name).filter((name) => name !== "." && name !== "..");
  }
  async rename(from: string, to: string): Promise<void> {
    await this.fs.move(from, to);
  }
  async remove(path: string): Promise<void> {
    if (!(await this.fs.remove(path))) throw new Error(`Missing removal ${path}`);
  }
  barrier(path?: string): Promise<void> {
    return this.fs.flush(path);
  }
}
let fs: SharedFilesystem | undefined;
let startup: Partial<Record<RuntimeStartupStage, number>> = {};
let startupReady: Promise<void> = Promise.resolve();
// Compile before browser filesystem/first-use clocks. Controller readiness
// deliberately includes this worker startup and compilation.
const guest = new WebAssembly.Module(guestFixture());
async function disposeFilesystem(): Promise<void> {
  if (!fs) return;
  const owned = fs;
  fs = undefined;
  try {
    if (owned.state.status === "ready" && !owned.ownershipLost) await owned.flush();
  } finally {
    await owned.dispose();
  }
}
function measuredOperation(target: WorkloadIO, property: string | symbol, operation: Function) {
  return async (...args: unknown[]) => {
    try {
      return await operation.apply(target, args);
    } catch (error) {
      const value = error as Error;
      throw Object.assign(
        new Error(
          `${String(property)} ${typeof args[0] === "string" ? args[0] : ""}: ${value.message}`,
        ),
        { cause: error, errno: (error as { errno?: number }).errno },
      );
    }
  };
}
async function verifyRevokedOwner(lane: Lane): Promise<Record<string, unknown>> {
  if (!fs!.ownershipLost) throw new Error("Old owner has not observed revocation");
  let probe: GuestIO | undefined;
  try {
    if (lane === "guest") probe = new GuestIO(fs!.client, guest);
    if (probe) await probe.read("/ownership-marker");
    else await fs!.readFile("/ownership-marker");
  } catch (error) {
    return { fenced: true, rejection: String(error) };
  } finally {
    probe?.dispose();
  }
  throw new Error("Revoked owner still served a filesystem operation");
}
function deleteEmptyWorkspace(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error);
  });
}
function awaitRevocation(empty: () => BrowserResult): Promise<BrowserResult> {
  return new Promise((resolve) => {
    fs!.onOwnershipLost = () => resolve({ ...empty(), ownershipLost: true });
  });
}
function createFilesystem(input: BrowserRequest): SharedFilesystem {
  startup = {};
  let ready!: () => void;
  startupReady = new Promise((resolve) => {
    ready = resolve;
  });
  return new SharedFilesystem(
    {
      workerURL: "/fs-worker.js",
      name: input.name,
      vfs: input.backend === "opfs" ? "opfs-memory" : "indexeddb",
      ...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
    },
    (stage, timestamp) => {
      startup[stage] = timestamp;
      if (stage === "filesystem-ready") ready();
    },
  );
}
function installGuestBarrier(guestIO: GuestIO, facade: SharedFilesystem): void {
  const barrier = guestIO.barrier.bind(guestIO);
  guestIO.barrier = async (path) => {
    await barrier(path);
    if (path === undefined) await facade.flush();
  };
}
async function request(input: BrowserRequest): Promise<BrowserResult> {
  const empty = (): BrowserResult => ({
    metrics: {},
    latencies: {},
    acknowledgements: [],
    observations: {},
  });
  if (input.action === "delete-empty") {
    if (fs || input.backend !== "indexeddb")
      throw new Error("Delete only a closed diagnostic IndexedDB workspace");
    await deleteEmptyWorkspace(input.name);
    return empty();
  }
  if (input.action === "seed") {
    const storage =
      input.backend === "indexeddb"
        ? await IndexedDBStorage.open(input.name)
        : await OpfsStorage.open(input.name);
    try {
      const batch = w1Fixture();
      await storage.persist(batch);
      await storage.flush();
    } finally {
      await storage.close();
    }
    return empty();
  }
  if (input.action === "await-revocation") {
    if (!fs) throw new Error("No owner to observe");
    if (fs.ownershipLost) return { ...empty(), ownershipLost: true };
    return awaitRevocation(empty);
  }
  if (input.action === "ownership")
    return { ...empty(), ownershipLost: fs?.ownershipLost ?? false, status: fs?.state.status };
  if (input.action === "dispose") {
    await disposeFilesystem();
    return empty();
  }
  const start = performance.now();
  if (!fs) fs = createFilesystem(input);
  if (input.action === "start") return { ...empty(), status: fs.state.status };
  if (input.action === "fence") {
    const observations = await verifyRevokedOwner(input.lane);
    return { ...empty(), observations };
  }
  await fs.resolvePath("/"); // Metadata readiness, without hydrating payloads.
  await startupReady; // Observe the existing ready milestone across message ports.
  const readyAt = performance.now();
  if (input.action === "open") {
    const metrics: Record<string, number> = { readinessMs: readyAt - start };
    if (input.backend === "indexeddb") {
      Object.assign(metrics, indexeddbStartupIntervals(startup));
    }
    return {
      ...empty(),
      ready: true,
      metrics,
      observations: { startupMilestones: { ...startup } },
    };
  }
  const facade = fs;
  const guestIO = input.lane === "guest" ? new GuestIO(facade.client, guest) : undefined;
  const io = guestIO ?? new HostIO(facade);
  // Namespace/global guest barriers include an explicit controller-owned global flush;
  // fd_sync(directory) itself promises targeted metadata, not all file payloads.
  if (guestIO) installGuestBarrier(guestIO, facade);
  // No per-operation resources() scans in the measured path. This end snapshot is
  // explicitly a resident lower bound, not a claimed high-water mark.
  const measured = new Proxy(io, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return measuredOperation(target, property, value);
    },
  });
  try {
    if (input.action === "marker") {
      await io.write("/ownership-marker", content(12345, 4096));
      await io.barrier();
      return empty();
    }
    if (input.action === "probe") {
      verify(await io.read("/ownership-marker"), 12345, 4096);
      return empty();
    }
    const result =
      input.action === "read"
        ? { ...empty(), metrics: await executeSequentialRead(measured) }
        : await executeWorkload(input.workload, measured, (operation, elapsedMs) =>
            globalThis.postMessage({ acknowledgement: { operation, elapsedMs } }),
          );
    result.metrics.readinessMs = readyAt - start;
    result.metrics.residentPayloadEndBytes = facade.client.shared.resources().usedBytes;
    result.observations = {
      ...result.observations,
      resident: facade.client.shared.resources(),
      hostLane:
        "SharedFilesystem facade; exposed async client RPC for offset IO/stat/readdir absent from whole-file facade",
      guestLane: "precompiled Wasm forwarding fixture -> preview1 -> FilesystemClient",
      namespaceBarrier: "guest directory fsync plus explicit global host flush",
      dirtyLag: "not exposed by current backends; not measured",
    };
    await facade.flush();
    return result;
  } finally {
    guestIO?.dispose();
  }
}
if (typeof document === "undefined") {
  globalThis.onmessage = async (event: MessageEvent<BrowserRequest>) => {
    try {
      globalThis.postMessage({ result: await request(event.data) });
    } catch (error) {
      const value = error as Error & { errno?: number; code?: string };
      globalThis.postMessage({
        error: {
          message: `${value.name}: ${value.message}`,
          stack: value.stack,
          errno: value.errno,
          code: value.code,
        },
      });
    }
  };
}
