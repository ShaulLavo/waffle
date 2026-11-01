import { ProcessError } from "../proc/types.ts";
import { createRuntime } from "../runtime.ts";
import { BrowserProcessBroker } from "../browser/process-broker.ts";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.ts";
import { DescriptorTable } from "../core/descriptors.ts";
import { createWorkerPipeCodec } from "../proc/worker-pipes.ts";
import { guestModule, store, i32, call } from "./threads-guest-module.ts";
import { FilesystemClient } from "../fs/client.ts";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec.ts";
import { RIGHTS_ALL } from "../core/rights.ts";
import { bytes, declareSharedMemoryPlatform } from "../memory/index.ts";

const selected = process.argv[2];
const NativeWorker = globalThis.Worker;
const workers: Worker[] = [];
let serviceConstructors = 0;
let guestConstructors = 0;
let cleanupCalls = 0;
let canonical: Worker | undefined;
const readCompleted = Promise.withResolvers<void>();
const drainRequested = Promise.withResolvers<boolean>();
const published = Promise.withResolvers<number>();
function observeCanonical(worker: Worker): void {
  canonical = worker;
  worker.addEventListener("message", ({ data }) => {
    if (data.kind === "fixture-read-completed") readCompleted.resolve();
    if (data.kind === "fixture-drain-requested") drainRequested.resolve(data.revoked);
    if (data.kind === "fixture-read-published") published.resolve(data.byte);
  });
}
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    const name = String(url);
    if (name.includes("/thread/service-worker")) serviceConstructors++;
    if (name.includes("/thread/guest-bootstrap")) guestConstructors++;
    if (selected?.startsWith("service-constructor") && name.includes("/thread/service-worker"))
      throw new Error("service constructor failed before native construction");
    super(url, options);
    workers.push(this);
    if (name.includes("late-read-service")) observeCanonical(this);
    if (selected === "service-handler" && name.includes("/thread/service-worker"))
      Object.defineProperty(this, "onmessage", {
        set() {
          throw new Error("service handler failed after native construction");
        },
      });
  }
};
const errors: string[] = [];
let filesystem: ConstructorParameters<typeof BrowserProcessBroker>[0]["filesystem"] | undefined;
let fileClient: FilesystemClient | undefined;
const runtime = createRuntime({
  sharedMemory: declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(3 * 1024 ** 3),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
  }),
  filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  processHost: (options) => {
    filesystem = options.filesystem;
    return new BrowserProcessBroker({ ...options, onError: (error) => errors.push(String(error)) });
  },
});
const descriptors = new DescriptorTable();
function bounded<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  const settled = promise.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error: String(error) }),
  );
  const pending = new Promise<{ kind: "pending" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "pending" }), ms);
  });
  return Promise.race([settled, pending]).finally(() => clearTimeout(timer));
}
function collectAgain(
  client: WorkerProcessClient,
  parent: number,
  pid: number,
): number | undefined {
  try {
    client.wait(parent, pid);
  } catch (error) {
    if (!(error instanceof ProcessError)) throw error;
    return error.errno;
  }
}
try {
  runtime.registerAdapter("failure", (context, service) =>
    service.launchWorker(context, {
      workerUrl: new URL("../browser/preview1-worker.ts", import.meta.url).href,
      threaded: {
        serviceWorkerUrl:
          selected === "late-read"
            ? new URL("./threads-runtime-late-read-service.ts", import.meta.url).href
            : new URL("../thread/service-worker.ts", import.meta.url).href,
        guestWorkerUrl: new URL("../thread/guest-bootstrap.ts", import.meta.url).href,
      },
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
      cleanup() {
        cleanupCalls++;
        if (selected === "adapter-cleanup" || selected === "service-constructor-cleanup")
          throw new Error("adapter cleanup failed");
      },
    }),
  );
  runtime.registerProgram("/failure", {
    adapter: "failure",
    source: guestModule({
      imports: [{ module: "wasi", name: "thread-spawn", params: [0x7f] }].concat(
        selected === "late-read"
          ? [
              {
                module: "wasi_snapshot_preview1",
                name: "fd_read",
                params: [0x7f, 0x7f, 0x7f, 0x7f],
              },
            ]
          : [],
      ),
      initial:
        selected === "late-read"
          ? store(256, i32(91)).concat(
              store(128, i32(256)),
              store(132, i32(1)),
              i32(0),
              i32(128),
              i32(1),
              i32(160),
              call(1),
              [0x1a],
            )
          : [],
    }),
  });
  await runtime.filesystem.writeFile("/failure", "registered");
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
    capacity: 8,
  });
  const rootFilesystem = runtime.filesystem.createIdentity();
  root.data = { filesystem: rootFilesystem };
  if (selected === "late-read") {
    if (!filesystem) throw new Error("process host did not receive its filesystem owner");
    await runtime.filesystem.writeFile("/payload", "A");
    fileClient = new FilesystemClient(filesystem.connect(rootFilesystem));
    const preopen: number = await fileClient.asyncCall("preopen", ["/"]);
    const { node: handle }: { node: number } = await fileClient.asyncCall("resolve", [
      preopen,
      "payload",
    ]);
    fileClient.retain(handle);
    descriptors.openAt(
      0,
      { kind: "file", handle, offset: 0, append: false },
      RIGHTS_ALL,
      RIGHTS_ALL,
      () => fileClient?.release(handle),
    );
  }
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: createWorkerPipeCodec(),
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => {
      const target = runtime.filesystem.createIdentity();
      return {
        data: { filesystem: target },
        codec: createWorkerPipeCodec({
          fallback: createFilesystemDescriptorCodec(fileClient, target),
        }),
      };
    },
  });
  await service.adoptRuntimeRoot(root, { memory: [], stop: () => descriptors.dispose() });
  const pid = client.spawn(root.pid, {
    executable: "/failure",
    argv: ["failure"],
    env: {},
    cwd: "/",
    job: -1,
    fds: selected === "late-read" ? [{ parent: 0, child: 0 }] : [],
  });
  while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  await supervisor.start(pid);
  let publication: unknown;
  if (selected === "late-read") {
    const ready = await bounded(readCompleted.promise, 2000);
    if (ready.kind !== "value") throw new Error("real Runtime file read did not complete");
    await service.kill(pid, 9);
    const revoked = await bounded(drainRequested.promise, 1000);
    canonical?.postMessage({ kind: "fixture-release-read" });
    publication = { revoked, byte: await bounded(published.promise, 1000) };
    canonical?.postMessage({ kind: "fixture-release-drain" });
  }
  const exit = await bounded(supervisor.waitForExit(root.pid, pid), 700);
  const startStatus = client.startStatus(root.pid, pid);
  const collected = selected === "service-constructor" ? client.wait(root.pid, pid) : undefined;
  const repeatedWait =
    selected === "service-constructor" ? collectAgain(client, root.pid, pid) : undefined;
  while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  const children = service.workerMemory();
  const disposal = await bounded(runtime.dispose(), 1800);
  const repeatedDisposal = await bounded(runtime.dispose(), 100);
  console.log(
    JSON.stringify({
      selected,
      serviceConstructors,
      guestConstructors,
      cleanupCalls,
      exit,
      startStatus,
      collected,
      repeatedWait,
      disposal,
      repeatedDisposal,
      children,
      publication,
      sharedGuests: runtime.sharedMemory.snapshot().sharedGuests,
      errors,
    }),
  );
} finally {
  canonical?.postMessage({ kind: "fixture-release-read" });
  canonical?.postMessage({ kind: "fixture-release-drain" });
  descriptors.dispose();
  fileClient?.dispose();
  await bounded(runtime.dispose(), 100);
  for (const worker of workers) await Reflect.apply(NativeWorker.prototype.terminate, worker, []);
  globalThis.Worker = NativeWorker;
}
