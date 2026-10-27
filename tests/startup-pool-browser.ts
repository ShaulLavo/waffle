import { createRuntime, type RuntimeSupervisor } from "../runtime.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await pause();
  }
  throw new Error("startup pool observation timed out");
}
function program(loop = false): Uint8Array {
  const header = [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0,
  ];
  return new Uint8Array(
    header.concat(loop ? [10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11] : [10, 4, 1, 2, 0, 11]),
  );
}

export async function browserStartupPool(): Promise<void> {
  const NativeWorker = globalThis.Worker;
  const created: Worker[] = [],
    stopped = new Set<Worker>(),
    used = new Set<Worker>();
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (url !== "/startup-pool-worker.js") return;
      created.push(this);
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "startup-pool-test") used.add(this);
      });
    }
    override terminate() {
      stopped.add(this);
      super.terminate();
    }
  };
  const runtime = createRuntime({
    filesystem: { workerURL: "/cell-fs-worker.js", mode: "memory" },
  });
  const reports: string[] = [],
    modules: WebAssembly.Module[] = [],
    notices: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  const demandConstructions: number[] = [];
  let loads = 0;
  runtime.registerAdapter("fixture", (context, service) => {
    modules.push(context.module);
    const before = created.length;
    const handle = service.launchWorker(context, {
      workerUrl: "/startup-pool-worker.js",
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
      onMessage(message) {
        if (typeof message !== "object" || message === null || !("value" in message)) return;
        if (typeof message.value === "string") reports.push(message.value);
      },
    });
    demandConstructions.push(created.length - before);
    return handle;
  });
  const source = program();
  const remove = runtime.registerProgram("/app", {
    adapter: "fixture",
    source: () => {
      loads++;
      return source;
    },
  });
  runtime.registerProgram("/loop", { adapter: "fixture", source: program(true) });
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  root.data = { filesystem: runtime.filesystem.createIdentity() };
  const unused = (): never => {
    throw new Error("unexpected descriptor transfer");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  const service = await runtime.processes();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
  };
  let supervisor: RuntimeSupervisor;
  const spawn = async (token: string, path = "/app") => {
    const pid = client.spawn(root.pid, {
      executable: path,
      argv: [token],
      env: { TOKEN: token },
      cwd: "/",
      job: -1,
      fds: [],
    });
    await flush();
    await supervisor.start(pid);
    return pid;
  };
  const wait = async (pid: number, code = 0) => {
    const result = await supervisor.waitForExit(root.pid, pid);
    assert(result.code === code, `unexpected exit ${JSON.stringify(result)}`);
    client.wait(root.pid, pid);
    await flush();
  };
  try {
    await runtime.filesystem.writeFile("/app", source);
    await runtime.filesystem.writeFile("/loop", program(true));
    await service.adoptRuntimeRoot(root);
    supervisor = await service.ready();
    await wait(await spawn("first"));
    await until(() => created.length === 3 && stopped.size === 1);
    const second = await spawn("second"),
      third = await spawn("third");
    assert(
      demandConstructions[1] === 0 && demandConstructions[2] === 0,
      "warm concurrent spawns constructed a Worker on demand",
    );
    await Promise.all([wait(second), wait(third)]);
    assert(
      loads === 1 && modules[0] === modules[1] && modules[0] === modules[2],
      "module cache missed concurrent/repeated launches",
    );
    await until(() => created.length === 5 && stopped.size === 3);
    for (const signal of [2, 9]) {
      const token = `loop-${signal}`;
      const loop = await spawn(token, "/loop");
      await until(() => reports.some((value) => value.startsWith(`${token}|`)));
      supervisor.kill(loop, signal);
      await wait(loop, signal);
    }
    await wait(await spawn("crash"), 5);
    await wait(await spawn("after-cancel"));
    remove();
    const replacement = new Uint8Array(Array.from(source).concat([0, 2, 1, 120]));
    runtime.registerProgram("/app", { adapter: "fixture", source: replacement });
    await runtime.filesystem.writeFile("/app", replacement);
    await wait(await spawn("replacement"));
    assert(modules.at(-1) !== modules[0], "replacement reused old compiled module");
    assert(
      reports.length === 8 && used.size === 8,
      "a process reused a used worker or lost its callback",
    );
    for (const value of reports) {
      const [args, env, runs, memory] = value.split("|");
      assert(args === env && runs === "1" && memory === "0", `stale process state ${value}`);
    }
    console.log(
      JSON.stringify({
        startupPool: {
          sourceLoads: loads,
          processes: used.size,
          warmSpawnsWithoutConstruction: 2,
          freshMemoryAndRealm: true,
          cancellation: "SIGINT and SIGKILL",
          replacementInvalidated: true,
        },
      }),
    );
  } finally {
    descriptors.dispose();
    await runtime.dispose();
    globalThis.Worker = NativeWorker;
    assert(
      created.every((worker) => stopped.has(worker)),
      "runtime disposal retained a worker",
    );
  }
}
