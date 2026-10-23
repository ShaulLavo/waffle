import { SharedFilesystem } from "../../browser/shared-fs.js";
import { createRuntime, type Runtime } from "../../runtime.js";
import { withVfsImplementation } from "../../fs/vfs-internal.js";
import { observe, type Outcome } from "../filesystem-shutdown-browser.js";

export const shutdownDebtPagePath = import.meta.filename;
export type DebtCase = "filesystem-close-error" | "filesystem-close-undefined" |
  "runtime-close-error" | "runtime-close-undefined" | "runtime-stop-error" | "runtime-late-stop";
export type DebtPage = ReturnType<typeof installPage>;
declare global { interface Window { shutdownDebt: DebtPage } }

function installPage() {
  let mode: DebtCase;
  let name = "";
  let filesystem: SharedFilesystem | undefined;
  let runtime: Runtime | undefined;
  let storageWorker: Worker | undefined;
  const consumers: Worker[] = [];
  const joins = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const stopEntered = Promise.withResolvers<void>();
  const failure = new Error("original native consumer stop failed");
  const stopCalls = [0, 0];
  let release: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  let result: Outcome<void> | { kind: "pending" } = { kind: "pending" };
  let ackCount = 0;
  const terminationRoles: string[] = [];
  const nativeWorker = globalThis.Worker;
  class RecordedWorker extends nativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (new URL(url, location.href).searchParams.get("role") !== "storage") return;
      storageWorker = this;
      this.addEventListener("message", (event) => {
        if (event.data?.type === "filesystem-disposed") ackCount++;
      });
    }
    override terminate(): void {
      terminationRoles.push(new URL(this === storageWorker ? "?role=storage" : "?role=consumer", location.href).search);
      super.terminate();
    }
  }
  function probe(action: "snapshot" | "late"): Promise<unknown> {
    const worker = storageWorker;
    if (!worker) throw new Error("Missing original storage Worker");
    return new Promise((resolve) => {
      const receive = (event: MessageEvent) => {
        if (event.data?.probe !== action) return;
        worker.removeEventListener("message", receive);
        resolve(event.data.value);
      };
      worker.addEventListener("message", receive);
      worker.postMessage({ probe: action });
    });
  }
  async function addConsumer(index: number): Promise<void> {
    if (!runtime) throw new Error("Missing original Runtime");
    const worker = new RecordedWorker(`/debt-worker.js?role=consumer&index=${index}`, { type: "module" });
    consumers.push(worker);
    await new Promise<void>((resolve) => worker.addEventListener("message", () => resolve(), { once: true }));
    const consumer = {
      filesystem: runtime.filesystem.createIdentity(),
      revoke() { release?.(); },
      stop() {
        stopCalls[index] = (stopCalls[index] ?? 0) + 1;
        if (index === 0) stopEntered.resolve();
        if (mode === "runtime-stop-error" && index === 0) return Promise.reject(failure);
        if (mode !== "runtime-late-stop" || index !== 0) worker.terminate();
        return joins[index]!.promise;
      },
    };
    const relinquish = runtime.retainConsumer(consumer);
    if (index === 0) release = relinquish;
  }
  async function start(next: DebtCase, database: string): Promise<void> {
    mode = next;
    name = database;
    const fault = next.includes("close");
    const reason = next.endsWith("undefined") ? "undefined" : "error";
    const options = withVfsImplementation("opfs-memory", {
      name,
      workerURL: `/debt-worker.js?role=storage&fault=${fault}&reason=${reason}`,
    });
    globalThis.Worker = RecordedWorker;
    try {
      if (next.startsWith("filesystem")) filesystem = new SharedFilesystem(options);
      else runtime = createRuntime({ filesystem: options });
    } finally { globalThis.Worker = nativeWorker; }
    const capability = filesystem ?? runtime?.filesystem;
    if (!capability) throw new Error("Missing original filesystem");
    await capability.writeFile("/marker", "native-close-debt");
    await capability.flush();
    if (next === "runtime-stop-error" || next === "runtime-late-stop") {
      await addConsumer(0);
      await addConsumer(1);
    }
    const owner = filesystem ?? runtime;
    if (!owner) throw new Error("Missing original disposal owner");
    disposal = owner.dispose();
    void observe(disposal).then((settled) => { result = settled; });
  }
  function state() {
    const owner = filesystem ?? runtime;
    if (!owner || !disposal) throw new Error("Missing original owner");
    return {
      result,
      samePromise: owner.dispose() === disposal,
      guardHeld: Reflect.has(globalThis, Symbol.for("waffle.runtime.owner")),
      filesystemState: filesystem?.state,
      stopCalls: stopCalls.slice(),
      originalStopReason: result.kind === "rejected" && result.reason === failure,
      ackCount,
      terminationRoles: terminationRoles.slice(),
    };
  }
  return {
    start,
    state,
    probe,
    stopped: () => stopEntered.promise,
    join(index: number) { joins[index]!.resolve(); },
    terminateConsumer(index: number) { consumers[index]!.terminate(); },
    late() { release?.(); joins[0]!.resolve(); },
    async lockAvailable() {
      return navigator.locks.request(`bun-wasm:filesystem:${name}`, { ifAvailable: true }, (lock) => lock !== null);
    },
    terminate() { for (const worker of consumers) worker.terminate(); storageWorker?.terminate(); },
    async deleteStorage() {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`bun-wasm-${btoa(JSON.stringify(name)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`, { recursive: true });
    },
  };
}
if (typeof window !== "undefined") window.shutdownDebt = installPage();
