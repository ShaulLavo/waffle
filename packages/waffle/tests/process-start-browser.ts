import { createRuntime, type ProcessStartState } from "../runtime.js";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals.js";
import { WorkerProcessClient, workerProcessPipeRegistry } from "../proc/worker-client.js";
import { WorkerPipeHost } from "../proc/worker-pipes.js";
import type { ProcessStartWorkerRequest } from "./fixtures/process-start-worker.js";
import { pageRootClient } from "./fixtures/page-root-client.js";
import { stopOrderModule } from "./fixtures/stop-order-wasm.js";

// docs/process-observation.md, "Start states", through the real runtime, broker and Worker.

export interface ProcessStartReport {
  readonly stages: readonly ProcessStartState[];
  /** A normal start, read once the guest's heartbeat moved. */
  readonly normal: ProcessStartState | undefined;
  /** A start whose worker script request never answered, read after it was posted. */
  readonly held: ProcessStartState | undefined;
  /** The same start read again after the page kept running for a while. */
  readonly heldLater: ProcessStartState | undefined;
  /** Exit code of the held start after SIGKILL. */
  readonly heldKilled: number;
  /** Exit code of a start whose worker script answered 404. */
  readonly missing: number;
  /** The normal start's realm `Atomics.wait`, read after bootstrap. */
  readonly realmWait: RealmWait | undefined;
}

/** docs/webkit-blocking-waits.md: a process Worker's realm wait is the runtime's wait. */
interface RealmWait {
  /** The realm's `Atomics.wait` is the runtime's wait. */
  readonly installed: boolean;
  /** The runtime's wait wraps the engine's on this engine. */
  readonly cooperative: boolean;
}

const pause = (ms = 1) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A hang cap only: generous enough for a loaded CI runner. */
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const limit = performance.now() + 30_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (performance.now() > limit) throw new Error(`process start timed out: ${label}`);
    await pause(2);
  }
}

/** @browserEntry Runs one normal, one held and one failed worker start and reports their states. */
export async function processStarts(): Promise<ProcessStartReport> {
  const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });
  const memories = new Map<number, WebAssembly.Memory>();
  let realmWait: RealmWait | undefined;
  const stages = ["installing-bindings", "bindings-installed", "instantiating"] as const;
  const gates = new Int32Array(new SharedArrayBuffer(stages.length * Int32Array.BYTES_PER_ELEMENT));
  const release = (index: number) => {
    Atomics.store(gates, index, 1);
    Atomics.notify(gates, index);
  };
  for (const [adapter, workerUrl] of [
    ["normal", "/worker.js"],
    ["held", "/held-worker.js"],
    ["missing", "/missing-worker.js"],
  ])
    runtime.registerAdapter(adapter!, (context, service) =>
      service.launchWorker<ProcessStartWorkerRequest>(context, {
        workerUrl: workerUrl!,
        request: {
          module: context.module,
          args: context.request.argv,
          env: {},
          gates: gates.buffer,
        },
        onMessage(message) {
          const data = message as { type?: string; memory?: WebAssembly.Memory } & RealmWait;
          if (data.type === "realm-wait")
            realmWait = { installed: data.installed, cooperative: data.cooperative };
          if (data.type === "stop-order-memory" && data.memory)
            memories.set(context.pid, data.memory);
        },
      }),
    );
  const source = stopOrderModule(1, true);
  const module = await WebAssembly.compile(source);
  for (const adapter of ["normal", "held", "missing"])
    runtime.registerProgram(`/${adapter}`, { adapter, module, cooperative: true });
  const { root, client: initialClient, descriptors, notices } = pageRootClient(runtime);
  const service = await runtime.processes();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  };
  const state = (pid: number) => service.startStates().find((entry) => entry.pid === pid);
  const waitForStage = (pid: number, step: (typeof stages)[number]) =>
    until(() => {
      const current = state(pid);
      return current?.step === step ? current : undefined;
    }, step);
  try {
    for (const adapter of ["normal", "held", "missing"])
      await runtime.filesystem.writeFile(`/${adapter}`, source);
    await service.adoptRuntimeRoot(root, { memory: [] });
    const pipes = new WorkerPipeHost({
      transport: root,
      postMessage: initialClient.options.postMessage,
      registry: workerProcessPipeRegistry(root),
    });
    const [reader, writer] = pipes.createPipe();
    descriptors.openAt(0, reader, 2n, 0n, () => reader.close());
    descriptors.openAt(1, writer, 64n, 0n, () => writer.close());
    descriptors.openAt(
      2,
      {
        kind: "terminal",
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      },
      64n,
      0n,
    );
    const client = new WorkerProcessClient({
      ...initialClient.options,
      codec: createRuntimeTerminalCodec({ descriptors, fallback: pipes.codec() }),
      prepareSpawn: (pid) => {
        const filesystem = runtime.filesystem.createIdentity();
        pipes.registry.registerProcess(pid);
        return { data: { filesystem }, cancel: () => pipes.registry.collectProcess(pid) };
      },
    });
    const supervisor = await service.ready();
    const spawn = async (executable: string) => {
      const pid = client.spawn(root.pid, {
        executable,
        argv: [executable],
        env: {},
        cwd: "/",
        job: -1,
        fds:
          executable === "/normal"
            ? [
                { child: 1, parent: 1 },
                { child: 2, parent: 2 },
              ]
            : [],
      });
      await flush();
      await supervisor.start(pid);
      return pid;
    };
    const reap = async (pid: number) => {
      const result = await supervisor.waitForExit(root.pid, pid);
      client.wait(root.pid, pid);
      await flush();
      return result.code;
    };

    const normalPid = await spawn("/normal");
    const observed: ProcessStartState[] = [];
    for (const [index, step] of stages.entries()) {
      observed.push(await waitForStage(normalPid, step));
      release(index);
    }
    await until(() => {
      const memory = memories.get(normalPid);
      return memory && Atomics.load(new Int32Array(memory.buffer), 0) > 2 ? true : undefined;
    }, "normal heartbeat");
    const normal = state(normalPid);
    await supervisor.kill(normalPid, 9);
    await reap(normalPid);

    const heldPid = await spawn("/held");
    const held = await until(() => {
      const current = state(heldPid);
      return current?.step === "start-posted" ? current : undefined;
    }, "held start posted");
    // Long enough for a loaded browser to have loaded a script it was going to load.
    await pause(500);
    const heldLater = state(heldPid);
    await supervisor.kill(heldPid, 9);
    const heldKilled = await reap(heldPid);
    await fetch("/release-held");

    const missingPid = await spawn("/missing");
    const missing = await reap(missingPid);
    // Ended starts leave the listing once their workers report or fail.
    await until(
      () => (service.startStates().length === 0 ? true : undefined),
      "start states to empty",
    );
    return { stages: observed, normal, held, heldLater, heldKilled, missing, realmWait };
  } finally {
    for (const index of stages.keys()) release(index);
    descriptors.dispose();
    await runtime.dispose();
  }
}
