import { BrowserProcessBroker } from "../browser/process-broker.js";
import { createRuntime } from "../runtime.js";
import { DescriptorTable } from "../core/descriptors.js";
import { RIGHTS_ALL } from "../core/rights.js";
import { inspectThreadSource } from "../memory/declarations.js";
import { bytes, declareSharedMemoryPlatform } from "../memory/index.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";

export type CThreadsRuntimeMode = "pair" | "repeat" | "nested";
export const cThreadArtifactSha256 =
  "07cbf777fee58c8a7e24402cae839dc5fa74795034e1dc3662b1db7b24b59cf6";
export const cThreadReceiptSha256 =
  "bb5f866e9ccd98a8ac5c47e87b64e5102741e64faabcdb7099f18b980608b140";

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), 15_000);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function workerAtomicControl(local: boolean) {
  const nonce = crypto.randomUUID();
  const shared = new SharedArrayBuffer(4);
  const worker = new Worker(
    local ? new URL("./c-threads-positive-worker.ts", import.meta.url).href : "/c-positive.js",
  );
  const reply = Promise.withResolvers<unknown>();
  worker.onmessage = (event) => reply.resolve(event.data);
  worker.onerror = (event) => reply.reject(new Error(event.message));
  const timeOrigin = performance.timeOrigin;
  const url = globalThis.location?.href ?? "Bun";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("C Worker/atomic positive control deadline")),
        10_000,
      );
    });
    worker.postMessage({ shared, nonce });
    const data = await Promise.race([reply.promise, expired]);
    check(
      data && typeof data === "object" && "nonce" in data && "atomic" in data,
      "C Worker/atomic positive control response missing",
    );
    check(
      data.nonce === nonce && data.atomic === 42 && Atomics.load(new Int32Array(shared), 0) === 42,
      "C Worker/atomic positive control did not arm",
    );
    return {
      nonce,
      atomic: 42,
      timeOrigin,
      url,
      isolated: globalThis.crossOriginIsolated ?? false,
    };
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

function sourceAdmission(source: Uint8Array) {
  try {
    return { kind: "accepted", declaration: inspectThreadSource(source) };
  } catch (error) {
    return { kind: "rejected", error: String(error) };
  }
}

function observeWorkers() {
  const NativeWorker = globalThis.Worker;
  const created: Worker[] = [];
  const stopped = new Set<Worker>();
  const urls: string[] = [];
  const memories = new Set<WebAssembly.Memory>();
  const initialBytes: number[] = [];
  const readyTids: number[] = [];
  const returnedTids: number[] = [];
  const guestMemoryObservations: { kind: unknown; tid: number; bytes: number }[] = [];
  const receive = ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== "object" || !("kind" in data) || !("thread" in data)) return;
    const thread = data.thread;
    if (
      !thread ||
      typeof thread !== "object" ||
      !("tid" in thread) ||
      typeof thread.tid !== "number"
    )
      return;
    if ("observedGuestBytes" in data && typeof data.observedGuestBytes === "number")
      guestMemoryObservations.push({
        kind: data.kind,
        tid: thread.tid,
        bytes: data.observedGuestBytes,
      });
    if (data.kind === "ready") readyTids.push(thread.tid);
    if (data.kind === "thread-returned") returnedTids.push(thread.tid);
  };
  const observe = (message: unknown) => {
    if (!message || typeof message !== "object" || !("memory" in message)) return;
    if (!(message.memory instanceof WebAssembly.Memory) || memories.has(message.memory)) return;
    memories.add(message.memory);
    initialBytes.push(message.memory.buffer.byteLength);
  };
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      created.push(this);
      urls.push(String(url));
      this.addEventListener("message", receive);
    }
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      observe(message);
      if (transfer === undefined) return super.postMessage(message);
      if (Array.isArray(transfer)) return super.postMessage(message, transfer);
      return super.postMessage(message, transfer);
    }
    override terminate() {
      const result = super.terminate();
      stopped.add(this);
      return result;
    }
  };
  const snapshot = () => ({
    ready: readyTids.length,
    returned: returnedTids.length,
    readyTids,
    returnedTids,
    guestMemoryObservations,
    workers: created.length,
    stopped: stopped.size,
    urls,
    initialGuestBytes: initialBytes,
    currentGuestBytes: Array.from(memories, (memory) => memory.buffer.byteLength),
  });
  return {
    snapshot,
    async close() {
      try {
        await Promise.all(created.map((worker) => worker.terminate()));
      } finally {
        globalThis.Worker = NativeWorker;
      }
    },
  };
}

/** The bytes enter the real registry, source admission, supervisor and thread broker. */
export async function runCThreadsRuntime(
  source: Uint8Array<ArrayBuffer>,
  selected: CThreadsRuntimeMode,
  local = false,
) {
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  check(digest === cThreadArtifactSha256, "C artifact changed in the execution host");
  const control = await workerAtomicControl(local);
  const observer = observeWorkers();
  const errors: string[] = [];
  const runtime = createRuntime({
    sharedMemory: declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: bytes(3 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
    }),
    filesystem: {
      mode: "memory",
      workerURL: local ? new URL("../browser/fs-worker.ts", import.meta.url) : "/fs-worker.js",
    },
    processHost: (options) =>
      new BrowserProcessBroker({ ...options, onError: (error) => errors.push(String(error)) }),
  });
  const descriptors = new DescriptorTable();
  const pipe = new PipeController({ relay: "manual" });
  try {
    runtime.registerAdapter("c-threads", (context, service) =>
      service.launchWorker(context, {
        workerUrl: local
          ? new URL("../browser/preview1-worker.ts", import.meta.url).href
          : "/preview1-worker.js",
        threaded: {
          serviceWorkerUrl: local
            ? new URL("../thread/service-worker.ts", import.meta.url).href
            : "/thread-service.js",
          guestWorkerUrl: local
            ? new URL("./c-threads-runtime-guest.ts", import.meta.url).href
            : "/thread-guest.js",
        },
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
        },
      }),
    );
    runtime.registerProgram("/bin/c-threads", { adapter: "c-threads", source });
    await runtime.filesystem.writeFile("/bin/c-threads", "registered");
    const service = await runtime.processes();
    const supervisor = await service.ready();
    const root = createWorkerProcessTransport({
      pid: runtime.identities.pid(),
      job: runtime.identities.job(),
      identity: runtime.identities.buffer,
      capacity: 8,
    });
    root.data = { filesystem: runtime.filesystem.createIdentity() };
    const reader = pipe.retain(root.pid, "read");
    descriptors.openAt(1, pipe.retain(root.pid, "write"), RIGHTS_ALL, RIGHTS_ALL);
    const notices: WorkerProcessMessage[] = [];
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: createWorkerPipeCodec(),
      postMessage: (message) => notices.push(message),
      prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    });
    await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
    const pid = client.spawn(root.pid, {
      executable: "/bin/c-threads",
      argv: ["c-threads", selected],
      env: {},
      cwd: "/",
      job: -1,
      fds: [
        { parent: 1, child: 1 },
        { parent: 1, child: 2 },
      ],
    });
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
    await supervisor.start(pid);
    const exit = await bounded(supervisor.waitForExit(root.pid, pid), "C Runtime exit deadline");
    const chunk = new Uint8Array(4096);
    const size = reader.tryRead([chunk]);
    const output = new TextDecoder().decode(chunk.subarray(0, Math.max(0, size)));
    reader.close();
    await bounded(runtime.dispose(), "C Runtime disposal deadline");
    const snapshot = runtime.sharedMemory.snapshot();
    const workers = observer.snapshot();
    const expectedChildren = selected === "repeat" ? 16 : 2;
    const passed =
      exit.kind === "exited" &&
      exit.code === 0 &&
      output === "c-threads-ok\n" &&
      workers.returned === expectedChildren &&
      workers.ready === expectedChildren + 1 &&
      new Set(workers.readyTids).size === expectedChildren + 1 &&
      new Set(workers.returnedTids).size === expectedChildren &&
      workers.returnedTids.every((tid) => tid !== 1 && workers.readyTids.includes(tid)) &&
      workers.initialGuestBytes.length === 1 &&
      workers.initialGuestBytes[0] === 17 * 65_536 &&
      workers.guestMemoryObservations.length > 0 &&
      workers.guestMemoryObservations.every(
        (item) => item.bytes >= 17 * 65_536 && item.bytes <= 512 * 65_536,
      ) &&
      snapshot.sharedGuests.length === 1 &&
      snapshot.sharedGuests.every(
        (item) =>
          item.initialPages === 17 &&
          item.actualMaximumPages === 512 &&
          item.sourceMaximumPages === 16_384 &&
          item.chargedBytes === 33_554_432 &&
          item.phase === "awaiting-collection" &&
          item.fence === "passed" &&
          item.aliases.retained === 0 &&
          item.continuations.active === 0,
      ) &&
      workers.stopped === workers.workers &&
      errors.length === 0 &&
      control.timeOrigin === performance.timeOrigin &&
      control.url === (globalThis.location?.href ?? "Bun");
    return {
      passed,
      selected,
      control,
      timeOrigin: performance.timeOrigin,
      documentURL: globalThis.location?.href ?? "Bun",
      artifactSha256: digest,
      sourceAdmission: sourceAdmission(source),
      exit,
      output,
      expectedChildren,
      ...workers,
      sharedGuests: snapshot.sharedGuests,
      debtBytes: snapshot.debtBytes,
      controlDebts: snapshot.holders.filter((holder) => holder.state === "debt"),
      errors,
      compilerInvoked: false,
      runtimeDisposed: runtime.disposed,
      isolated: globalThis.crossOriginIsolated ?? false,
    };
  } finally {
    descriptors.dispose();
    pipe.dispose();
    try {
      await bounded(runtime.dispose(), "C Runtime final disposal deadline");
    } finally {
      await observer.close();
    }
  }
}
