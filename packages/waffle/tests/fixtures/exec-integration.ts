import { processFilesystem } from "./process-filesystem.js";
import { BrowserProcessBroker } from "../../browser/process-broker.js";
import { createRuntimeTerminalCodec } from "../../browser/runtime-terminals.js";
import { DescriptorTable } from "../../core/descriptors.js";
import { createNullDevice } from "../../core/devices.js";
import { MemoryBackend } from "../../fs/backend.js";
import { FilesystemService } from "../../fs/service.js";
import { createFilesystemIdentity } from "../../fs/protocol.js";
import {
  SharedMemoryLedger,
  declareSharedMemoryPlatform,
  bytes,
} from "../../memory/reservations.js";
import { ProcessIdentityAllocator } from "../../proc/identity.js";
import { ExecutableRegistry } from "../../proc/registry.js";
import { ProcessTable } from "../../proc/table.js";
import type { ExecRequest, ProcessExit } from "../../proc/types.js";
import {
  WorkerProcessClient,
  createWorkerProcessTransport,
  type WorkerProcessMessage,
} from "../../proc/worker-client.js";
import { createWorkerPipeCodec } from "../../proc/worker-pipes.js";
import { groupLinkProgram } from "./group-link-program.js";
import { execCallerGuest, execTargetGuest } from "./exec-guest.js";

export type ExecIntegrationMode =
  | "replace"
  | "twice"
  | "preopen-remap"
  | "omit-preopen"
  | "capacity-exec"
  | "capacity-control";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("exec integration deadline")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runExecIntegration(options: {
  workerUrl: string;
  mode: ExecIntegrationMode;
}) {
  const capacity = options.mode.startsWith("capacity");
  const control = options.mode === "capacity-control";
  const preservePreopen = options.mode !== "omit-preopen";
  const openFile = !capacity && preservePreopen && options.mode !== "preopen-remap";
  const images = options.mode === "twice" ? 3 : 2;
  const platform = declareSharedMemoryPlatform(
    capacity
      ? {
          kind: "bounded",
          budgetBytes: bytes(384 * 1024 ** 2),
          counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
        }
      : { kind: "unbounded" },
  );
  const reservations = new SharedMemoryLedger(platform).openRuntime(platform);
  const NativeWorker = globalThis.Worker;
  const workers: Worker[] = [];
  const stopped = new Set<Worker>();
  const events: string[] = [];
  const ports: MessagePort[] = [];
  const errors: unknown[] = [];
  const exits: { pid: number; parentPid: number; result: ProcessExit }[] = [];
  const notices: WorkerProcessMessage[] = [];
  let launching = "";
  const labels = new WeakMap<Worker, string>();
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, configuration?: WorkerOptions) {
      super(url, configuration);
      workers.push(this);
      labels.set(this, launching);
      events.push(`worker:${launching}`);
    }
    override terminate() {
      const complete = () => {
        stopped.add(this);
        events.push(`stopped:${labels.get(this)}`);
      };
      const pending: unknown = Reflect.apply(NativeWorker.prototype.terminate, this, []);
      if (pending && typeof pending === "object" && "then" in pending)
        return Promise.resolve(pending).then(complete);
      complete();
    }
  };
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  const backend = new MemoryBackend();
  backend.fs.writeFile("/exec-file", new TextEncoder().encode("kept"));
  const filesystem = new FilesystemService(backend);

  const group = capacity ? await groupLinkProgram() : undefined;
  let pid = 0;
  let targetAdmissionGuestBytes: number | undefined;
  const request: ExecRequest = {
    executable: options.mode === "twice" ? "middle" : "target",
    argv: ["next", "a b"],
    env: { NEW: "value" },
    cwd: "/next",
    fds: (preservePreopen
      ? [
          { parent: 1, child: 1 },
          { parent: options.mode === "preopen-remap" ? 4 : 3, child: 3 },
        ]
      : [{ parent: 1, child: 1 }]
    ).concat(
      openFile
        ? [
            { parent: 0, child: 7 },
            { parent: 4, child: 11 },
          ]
        : [],
    ),
  };
  registry.register("caller", {
    adapter: "fixture",
    module: () => execCallerGuest(request, control, capacity ? 1024 : 64, openFile),
  });
  registry.register("middle", {
    adapter: "fixture",
    module: () =>
      execCallerGuest({
        ...request,
        executable: "target",
        fds: request.fds.map((binding) => ({ parent: binding.child, child: binding.child })),
      }),
  });
  registry.register("target", {
    adapter: "fixture",
    module: () => group?.module ?? execTargetGuest(pid, request, preservePreopen),
  });
  let output = "";
  const broker = new BrowserProcessBroker({
    reservations,
    identities,
    table,
    registry,
    memoryGroups: { maximumPages: 1024, stackBytes: 65536 },
    onError: (error) => errors.push(error),
    filesystem: processFilesystem(filesystem, reservations, ports),
    launch(context) {
      launching = `${context.pid}:${context.generation}`;
      events.push(`admitting:${launching}`);
      if (context.request.executable === "target")
        targetAdmissionGuestBytes = reservations
          .snapshot()
          .holders.filter((holder) => holder.label === "guest-memory")
          .reduce((sum, holder) => sum + holder.declaredBytes, 0);
      const selectedGroup = context.request.executable === "target" ? group : undefined;
      return broker.launchWorker(context, {
        workerUrl: options.workerUrl,
        memoryGroup: selectedGroup ? "new" : undefined,
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          ...(selectedGroup ? { linkPlan: selectedGroup.linkPlan } : {}),
        },
      });
    },
  });
  const descriptors = new DescriptorTable();
  const terminal = {
    kind: "terminal" as const,
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
  descriptors.openAt(1, terminal, (1n << 29n) - 1n, 0n);
  descriptors.openAt(2, { ...terminal }, (1n << 29n) - 1n, 0n);
  descriptors.openAt(9, createNullDevice(), 0n, 0n);
  const rootFilesystem = createFilesystemIdentity();
  const root = createWorkerProcessTransport({ identity: identities.buffer, capacity: 16 });
  root.data = { filesystem: rootFilesystem };
  const parent = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() }),
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(rootFilesystem) } }),
  });
  try {
    await broker.adoptRuntimeRoot(root, {
      memory: [],
      output: (_fd, data) => {
        output += new TextDecoder().decode(data);
      },
    });
    const supervisor = await broker.ready();
    supervisor.onChildExit((event) => exits.push(event));
    pid = parent.spawn(root.pid, {
      executable: "caller",
      argv: ["caller"],
      env: {},
      cwd: "/",
      job: -1,
      fds: [
        { parent: 1, child: 1 },
        { parent: 2, child: 2 },
        { parent: 9, child: options.mode === "preopen-remap" ? 3 : 9 },
      ],
    });
    for (const message of notices.splice(0)) await broker.runtimeMessage(message, root.pid);
    await supervisor.start(pid);
    const record = table.require(pid);
    const result = await bounded(supervisor.waitForExit(root.pid, pid));
    await bounded(record.stopping!.complete);
    assert(
      result.kind === "exited" && result.code === 0,
      `caller failed: ${JSON.stringify(result)}; ${errors.map(String).join("; ")}; ${output}`,
    );
    const failed = exits.find(
      (event) => event.parentPid === pid && event.result.kind === "start-failed",
    );
    if (control) {
      assert(
        failed?.result.kind === "start-failed" && failed.result.error === "ENOMEM",
        "spawn-and-wait control did not receive ENOMEM",
      );
      assert(workers.length === 1, "refused spawn constructed a target Worker");
    } else {
      assert(
        record.image.generation === images && workers.length === images,
        "replacement did not keep one PID across images",
      );
      assert(targetAdmissionGuestBytes === 0, "old memory remained charged at target admission");
      for (let generation = 1; generation < images; generation++)
        assert(
          events.indexOf(`stopped:${pid}:${generation}`) <
            events.indexOf(`admitting:${pid}:${generation + 1}`),
          "target admission preceded old physical stop",
        );
      if (!capacity) assert(output === "exec-ok\n", `successor terminal output missing: ${output}`);
      assert(errors.length === 0, errors.map(String).join("; "));
    }
    assert(stopped.size === workers.length, "an image Worker remained alive");
    return {
      mode: options.mode,
      pid,
      result,
      images: workers.length,
      output,
      targetAdmissionGuestBytes,
      controlFailure: failed?.result,
      events,
      budgetBytes: reservations.snapshot().budgetBytes,
    };
  } finally {
    try {
      await broker.dispose();
    } finally {
      await Promise.all(
        workers.filter((worker) => !stopped.has(worker)).map((worker) => worker.terminate()),
      );
      descriptors.dispose();
      filesystem.dispose();
      for (const port of ports) port.close();
      reservations.dispose();
      globalThis.Worker = NativeWorker;
    }
  }
}
