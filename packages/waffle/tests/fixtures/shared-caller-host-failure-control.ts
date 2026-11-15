import assert from "node:assert/strict";
import { createRuntime } from "../../runtime.js";
import { captureProcessObserver } from "../../proc/observation.js";

const NativeWorker = globalThis.Worker;
const workers: Worker[] = [];
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers.push(this);
  }
};
const runtime = createRuntime({
  filesystem: {
    mode: "memory",
    workerURL: new URL("../../browser/fs-worker.ts", import.meta.url),
  },
});
let channel: MessageChannel | undefined;
let controllerLaunches = 0;
let controllerStops = 0;
let genericLaunches = 0;
try {
  runtime.registerHostAdapter("host", (context, service) => {
    genericLaunches++;
    channel = new MessageChannel();
    if (process.argv[2] === "forbidden")
      return service.launchWorker(context, {
        workerUrl: "must-not-construct",
        request: { module: context.module, args: [], env: {} },
      });
    const failure = new Error("host launcher accepted local work before failing");
    if (process.argv[2] === "reject") return Promise.reject(failure);
    throw failure;
  });
  runtime.registerProgram("/host", {
    adapter: "host",
    cooperative: true,
    module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
  });
  await runtime.filesystem.writeFile("/host", "registered");
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const root = supervisor.createRoot();
  const pid = supervisor.reserveSpawn(root, {
    executable: "/host",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  service.registerController(pid, {
    filesystem: runtime.filesystem.createIdentity(),
    launch() {
      controllerLaunches++;
      throw new Error("unselected controller launch");
    },
    stop() {
      controllerStops++;
    },
  });
  const observer = captureProcessObserver(supervisor.get(pid)!.observation);
  await supervisor.start(pid);
  const exit = await supervisor.waitForExit(root, pid);
  let disposalRejected = false;
  await runtime.dispose().catch(() => {
    disposalRejected = true;
  });
  assert.equal(genericLaunches, 1);
  assert.equal(controllerLaunches, 0);
  assert.equal(workers.length, 1);
  console.log(
    JSON.stringify({
      mode: process.argv[2],
      exit,
      genericLaunches,
      controllerLaunches,
      controllerStops,
      localConsumerAccepted: channel !== undefined,
      disposalRejected,
      observation: observer.read(),
      nativeWorkersCreated: workers.length,
    }),
  );
} finally {
  channel?.port1.close();
  channel?.port2.close();
  await runtime.dispose().catch(() => {});
  for (const worker of workers) await Reflect.apply(NativeWorker.prototype.terminate, worker, []);
  globalThis.Worker = NativeWorker;
}
