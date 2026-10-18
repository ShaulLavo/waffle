import {
  SharedFilesystem,
  type SharedFilesystemOptions,
  type SharedFilesystemState,
  type SharedFilesystemStorage,
} from "../browser/shared-fs.js";

type Backend = SharedFilesystemStorage;
type Busy = "wait" | "takeover";

type StateRecord = {
  status: SharedFilesystemState["status"];
  error?: string;
};

const NativeWorker = globalThis.Worker;
let terminations = 0;
let clientDisposals = 0;
let filesystemWorker: Worker | undefined;
const probes: string[] = [];
let holdOwnershipLoss = false;
let heldOwnershipLoss: MessageEvent | undefined;
let disposal: { status: "idle" | "pending" | "fulfilled" | "rejected"; error?: string } = {
  status: "idle",
};
// Instrument calls without replacing the actual browser worker or storage implementation.
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    // oxlint-disable-next-line typescript/no-this-alias -- This test records the actual callback/Worker receiver.
    filesystemWorker = this;
    this.addEventListener("message", (event) => {
      if (typeof event.data?.type === "string") {
        probes.push(event.data.type);
        if (typeof event.data.status === "string")
          probes.push(`${event.data.type}:${event.data.status}`);
      }
      if (holdOwnershipLoss && event.data?.type === "filesystem-ownership-lost") {
        heldOwnershipLoss = event;
        event.stopImmediatePropagation();
      }
    });
  }
  terminate(): void {
    terminations++;
    super.terminate();
  }
};
let fs: SharedFilesystem | undefined;
let state: StateRecord = { status: "opening" };
const states: StateRecord[] = [];
type OperationRecord = {
  status: "idle" | "pending" | "fulfilled" | "rejected";
  error?: string;
  errno?: number;
  isError?: boolean;
  name?: string;
  message?: string;
};
let operation: OperationRecord = { status: "idle" };
const directWrites: Record<"queued" | "new", OperationRecord> = {
  queued: { status: "idle" },
  new: { status: "idle" },
};

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
  const disposeClient = filesystem.client.dispose.bind(filesystem.client);
  filesystem.client.dispose = () => {
    clientDisposals++;
    disposeClient();
  };
  const hasTypedState = () => (filesystem as { state?: unknown }).state !== undefined;
  void filesystem.listFiles().then(
    () => {
      if (!hasTypedState()) state = { status: "ready" };
    },
    (error) => {
      if (!hasTypedState()) state = { status: "failed", error: errorText(error) };
    },
  );
  filesystem.onOwnershipLost = () => {
    if (!hasTypedState())
      state = { status: "failed", error: "This workspace was opened in another tab." };
  };
}
function lockName(backend: Backend, name: string): string {
  return backend === "indexeddb"
    ? `bun-wasm:filesystem:indexeddb:${name}`
    : `bun-wasm:filesystem:${name}`;
}

async function start(
  backend: Backend,
  name: string,
  whenBusy?: Busy,
  gatedRecovery: boolean | "recovered" = false,
): Promise<void> {
  if (fs) throw new Error("filesystem already started");
  holdOwnershipLoss = gatedRecovery === "recovered";
  const options: SharedFilesystemOptions = {
    workerURL:
      gatedRecovery === "recovered"
        ? "/recovery-fs-worker.js?recovered"
        : gatedRecovery
          ? "/recovery-fs-worker.js"
          : "/fs-worker.js",
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
  state: (): StateRecord => {
    const current = (fs as { state?: SharedFilesystemState } | undefined)?.state;
    return current ? { status: current.status, error: current.error?.message } : state;
  },
  states: () => states,
  operation: () => operation,
  lockName,
  resources: () => ({ terminations, clientDisposals }),
  probes: () => probes,
  disposal: () => disposal,
  beginDispose(): void {
    if (disposal.status !== "idle") throw new Error("disposal already started");
    disposal = { status: "pending" };
    void requireFilesystem()
      .dispose()
      .then(
        () => {
          disposal = { status: "fulfilled" };
        },
        (error) => {
          disposal = { status: "rejected", error: errorText(error) };
        },
      );
  },
  releaseRecovery(): void {
    if (!filesystemWorker) throw new Error("filesystem worker has not been created");
    filesystemWorker.postMessage({ probeReleaseRecovery: true });
  },
  releaseOwnershipLoss(): void {
    if (!filesystemWorker || !heldOwnershipLoss) throw new Error("no held ownership-loss message");
    holdOwnershipLoss = false;
    filesystemWorker.dispatchEvent(new MessageEvent("message", { data: heldOwnershipLoss.data }));
    heldOwnershipLoss = undefined;
  },
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
    void filesystem
      .writeFile("/queued", text)
      .then(() => filesystem.flush())
      .then(
        () => {
          operation = { status: "fulfilled" };
        },
        (error) => {
          operation = {
            status: "rejected",
            error: errorText(error),
            errno: (error as { errno?: number }).errno,
            isError: error instanceof Error,
            name: error?.name,
            message: error?.message,
          };
        },
      );
  },
  directWrite: (label: "queued" | "new") => directWrites[label],
  beginDirectWrite(label: "queued" | "new", text: string): void {
    if (directWrites[label].status !== "idle") throw new Error("direct write already started");
    directWrites[label] = { status: "pending" };
    // Observe writeFile itself: a later flush failure must not hide an accepted write.
    void requireFilesystem()
      .writeFile("/queued", text)
      .then(
        () => {
          directWrites[label] = { status: "fulfilled" };
        },
        (error) => {
          directWrites[label] = {
            status: "rejected",
            error: errorText(error),
            errno: (error as { errno?: number }).errno,
            isError: error instanceof Error,
            name: error?.name,
            message: error?.message,
          };
        },
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
    try {
      fs = new SharedFilesystem(invalid);
      observeOperationalReadiness(fs);
    } catch (error) {
      record({
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  },
};

type LockManagerSnapshot = Awaited<ReturnType<LockManager["query"]>>;
