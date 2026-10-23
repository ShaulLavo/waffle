import { SharedFilesystem } from "../../browser/shared-fs.js";
import { createRuntime, type Runtime } from "../../runtime.js";
import { withVfsImplementation } from "../../fs/vfs-internal.js";
import { isRecord, observe, type Outcome } from "../filesystem-shutdown-browser.js";

export const shutdownDebtPagePath = import.meta.filename;
export type DebtCase =
  | "filesystem-close-error"
  | "filesystem-close-undefined"
  | "runtime-close-error"
  | "runtime-close-undefined"
  | "runtime-stop-error"
  | "runtime-late-stop";
export type DebtPage = ShutdownDebtPage;
declare global {
  interface Window {
    shutdownDebt: DebtPage;
  }
}

function workerClass(owner: ShutdownDebtPage): typeof Worker {
  return class extends Worker {
    private readonly role: string;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.role = new URL(url, location.href).searchParams.get("role") ?? "";
      if (this.role === "storage") owner.captureStorage(this);
    }
    override terminate(): void {
      owner.recordTermination(this.role);
      super.terminate();
    }
  };
}
class ShutdownDebtPage {
  private mode: DebtCase | undefined;
  private name = "";
  private filesystem: SharedFilesystem | undefined;
  private runtime: Runtime | undefined;
  private storageWorker: Worker | undefined;
  private readonly consumers: Worker[] = [];
  private readonly joins = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  private readonly stopEntered = Promise.withResolvers<void>();
  private readonly failure = new Error("original native consumer stop failed");
  private readonly stopCalls = [0, 0];
  private release: (() => void) | undefined;
  private disposal: Promise<void> | undefined;
  private result: Outcome<void> | { kind: "pending" } = { kind: "pending" };
  private ackCount = 0;
  private readonly terminationRoles: string[] = [];
  private readonly RecordedWorker = workerClass(this);

  captureStorage(worker: Worker): void {
    this.storageWorker = worker;
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (isRecord(event.data) && event.data.type === "filesystem-disposed") this.ackCount++;
    });
  }
  recordTermination(role: string): void {
    this.terminationRoles.push(role);
  }
  probe(action: "snapshot" | "late"): Promise<unknown> {
    const worker = this.storageWorker;
    if (!worker) throw new Error("Missing original storage Worker");
    return new Promise((resolve) => {
      const receive = (event: MessageEvent<unknown>) => {
        if (!isRecord(event.data) || event.data.probe !== action) return;
        worker.removeEventListener("message", receive);
        resolve(event.data.value);
      };
      worker.addEventListener("message", receive);
      worker.postMessage({ probe: action });
    });
  }
  private async addConsumer(index: number): Promise<void> {
    if (!this.runtime) throw new Error("Missing original Runtime");
    const worker = new this.RecordedWorker(`/debt-worker.js?role=consumer&index=${index}`, {
      type: "module",
    });
    this.consumers.push(worker);
    await new Promise<void>((resolve) =>
      worker.addEventListener("message", () => resolve(), { once: true }),
    );
    const consumer = {
      filesystem: this.runtime.filesystem.createIdentity(),
      revoke: () => this.release?.(),
      stop: () => {
        this.stopCalls[index] = (this.stopCalls[index] ?? 0) + 1;
        if (index === 0) this.stopEntered.resolve();
        if (this.mode === "runtime-stop-error" && index === 0) return Promise.reject(this.failure);
        if (this.mode !== "runtime-late-stop" || index !== 0) worker.terminate();
        return this.joins[index]!.promise;
      },
    };
    const relinquish = this.runtime.retainConsumer(consumer);
    if (index === 0) this.release = relinquish;
  }
  async start(next: DebtCase, database: string): Promise<void> {
    this.mode = next;
    this.name = database;
    const fault = next.includes("close");
    const reason = next.endsWith("undefined") ? "undefined" : "error";
    const options = withVfsImplementation("opfs-memory", {
      name: this.name,
      workerURL: `/debt-worker.js?role=storage&fault=${fault}&reason=${reason}`,
    });
    const nativeWorker = globalThis.Worker;
    globalThis.Worker = this.RecordedWorker;
    try {
      if (next.startsWith("filesystem")) this.filesystem = new SharedFilesystem(options);
      else this.runtime = createRuntime({ filesystem: options });
    } finally {
      globalThis.Worker = nativeWorker;
    }
    const capability = this.filesystem ?? this.runtime?.filesystem;
    if (!capability) throw new Error("Missing original filesystem");
    await capability.writeFile("/marker", "native-close-debt");
    await capability.flush();
    if (next === "runtime-stop-error" || next === "runtime-late-stop") {
      await this.addConsumer(0);
      await this.addConsumer(1);
    }
    const owner = this.filesystem ?? this.runtime;
    if (!owner) throw new Error("Missing original disposal owner");
    this.disposal = owner.dispose();
    void observe(this.disposal).then((settled) => {
      this.result = settled;
    });
  }
  state() {
    const owner = this.filesystem ?? this.runtime;
    if (!owner || !this.disposal) throw new Error("Missing original owner");
    return {
      result: this.result,
      samePromise: owner.dispose() === this.disposal,
      guardHeld: Reflect.has(globalThis, Symbol.for("waffle.runtime.owner")),
      filesystemState: this.filesystem?.state,
      stopCalls: this.stopCalls.slice(),
      originalStopReason: this.result.kind === "rejected" && this.result.reason === this.failure,
      ackCount: this.ackCount,
      terminationRoles: this.terminationRoles.slice(),
    };
  }
  stopped() {
    return this.stopEntered.promise;
  }
  join(index: number) {
    this.joins[index]!.resolve();
  }
  terminateConsumer(index: number) {
    this.consumers[index]!.terminate();
  }
  late() {
    this.release?.();
    this.joins[0]!.resolve();
  }
  async lockAvailable() {
    return navigator.locks.request(
      `bun-wasm:filesystem:${this.name}`,
      { ifAvailable: true },
      (lock) => lock !== null,
    );
  }
  terminate() {
    for (const worker of this.consumers) worker.terminate();
    this.storageWorker?.terminate();
  }
  async deleteStorage() {
    if (!(await this.lockAvailable()))
      throw new Error("Original native lock remains after explicit Worker close");
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(
      `bun-wasm-${btoa(JSON.stringify(this.name)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`,
      { recursive: true },
    );
  }
}
if (typeof window !== "undefined") window.shutdownDebt = new ShutdownDebtPage();
