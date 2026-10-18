import { SharedFilesystem } from "../browser/shared-fs.js";
import type { SharedFilesystemOptions, SharedFilesystemState, SharedFilesystemStorage } from "../browser/shared-fs.js";

type Backend = SharedFilesystemStorage;
type Busy = "wait" | "takeover";

type StateRecord = {
  status: SharedFilesystemState["status"];
  error?: string;
};

const NativeWorker = globalThis.Worker;
let terminations = 0;
// Instrument calls without replacing the actual browser worker or storage implementation.
globalThis.Worker = class extends NativeWorker {
  terminate(): void { terminations++; super.terminate(); }
};
let fs: SharedFilesystem | undefined;
let state: StateRecord = { status: "opening" };
const states: StateRecord[] = [];
let operation: { status: "idle" | "pending" | "fulfilled" | "rejected"; error?: string } = { status: "idle" };

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function record(next: SharedFilesystemState): void {
  state = { status: next.status, error: next.error?.message };
  states.push(state);
}
function requireFilesystem(): SharedFilesystem {
  if (!fs) throw new Error("filesystem has not been started");
  return fs;
}
// --source can run this harness against the pre-feature revision. Operational
// probes let its owner/control pages start; contested pages must still expose the
// new typed waiting state and cannot pass by merely leaving a request pending.
function observeOperationalReadiness(filesystem: SharedFilesystem): void {
  const hasTypedState = () => (filesystem as { state?: unknown }).state !== undefined;
  void filesystem.listFiles().then(
    () => { if (!hasTypedState()) state = { status: "ready" }; },
    error => { if (!hasTypedState()) state = { status: "failed", error: errorText(error) }; },
  );
  filesystem.onOwnershipLost = () => {
    if (!hasTypedState()) state = { status: "failed", error: "This workspace was opened in another tab." };
  };
}
function lockName(backend: Backend, name: string): string {
  return backend === "indexeddb" ? `bun-wasm:filesystem:indexeddb:${name}` : `bun-wasm:filesystem:${name}`;
}

async function start(backend: Backend, name: string, whenBusy?: Busy): Promise<void> {
  if (fs) throw new Error("filesystem already started");
  const options: SharedFilesystemOptions = {
    workerURL: "/fs-worker.js",
    name,
    storage: backend,
    onStateChange: record,
  };
  if (whenBusy !== undefined) (options as { whenBusy?: Busy }).whenBusy = whenBusy;
  fs = new SharedFilesystem(options);
  observeOperationalReadiness(fs);
}

(globalThis as typeof globalThis & { lockTest?: unknown }).lockTest = {
  start,
  state: () => state,
  states: () => states,
  operation: () => operation,
  lockName,
  terminations: () => terminations,
  async seed(): Promise<string> {
    const filesystem = requireFilesystem();
    await filesystem.writeFile("/saved", "durable marker");
    await filesystem.flush();
    const saved = await filesystem.readFile("/saved");
    return new TextDecoder().decode(saved);
  },
  async readSaved(): Promise<string | undefined> {
    const saved = await requireFilesystem().readFile("/saved");
    return saved === undefined ? undefined : new TextDecoder().decode(saved);
  },
  beginWrite(text: string): void {
    if (operation.status !== "idle") throw new Error("operation already started");
    operation = { status: "pending" };
    const filesystem = requireFilesystem();
    void filesystem.writeFile("/queued", text).then(() => filesystem.flush()).then(
      () => { operation = { status: "fulfilled" }; },
      error => { operation = { status: "rejected", error: errorText(error) }; },
    );
  },
  async readQueued(): Promise<string | undefined> {
    const value = await requireFilesystem().readFile("/queued");
    return value === undefined ? undefined : new TextDecoder().decode(value);
  },
  async dispose(): Promise<void> {
    await fs?.dispose();
  },
  async lockBarrier(backend: Backend, name: string): Promise<void> {
    await navigator.locks.request(lockName(backend, name), { mode: "exclusive" }, () => {});
  },
  async queryLocks(): Promise<LockManagerSnapshot> {
    return navigator.locks.query();
  },
  async failWithOpfsTakeover(name: string): Promise<void> {
    const invalid = {
      workerURL: "/fs-worker.js",
      name,
      storage: "opfs",
      whenBusy: "takeover",
      onStateChange: record,
    } as unknown as SharedFilesystemOptions;
    fs = new SharedFilesystem(invalid);
    observeOperationalReadiness(fs);
  },
};

type LockManagerSnapshot = Awaited<ReturnType<LockManager["query"]>>;
