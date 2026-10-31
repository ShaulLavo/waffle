import { testSharedMemory } from "./shared-memory-platform.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../../runtime.js";
import { ProcessSupervisor } from "../../proc/supervisor.js";
import { MemoryBackend } from "../../fs/backend.js";
import { FilesystemService } from "../../fs/service.js";
import type { FilesystemConnection } from "../../fs/protocol.js";

export const runtimeStopControlPath = import.meta.filename;

function failureFor(kind: string): unknown {
  switch (kind) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "false":
      return false;
    case "zero":
      return 0;
    case "empty":
      return "";
    case "object":
      return Object.freeze({ failure: "original stop" });
    default:
      return new Error("original stop failed");
  }
}

async function observe(pending: Promise<void>) {
  return pending.then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

function hostFactory(
  events: string[],
  hostJoin: Promise<void>,
  started: () => void,
): NonNullable<RuntimeOptions["processHost"]> {
  return (options) => {
    const supervisor = new ProcessSupervisor({
      registry: options.registry,
      table: options.table,
      launch: options.launch,
    });
    return {
      ready: async () => supervisor,
      suspend: () => supervisor.dispose(),
      quiesce: async () => {},
      dispose() {
        events.push("host:stop");
        started();
        return hostJoin;
      },
    } as Awaited<ReturnType<NonNullable<RuntimeOptions["processHost"]>>>;
  };
}

async function launchAdapter(runtime: Runtime, stop: () => Promise<void>, late: boolean) {
  const admitted = Promise.withResolvers<void>();
  const launchGate = Promise.withResolvers<void>();
  runtime.registerAdapter("test", async () => {
    admitted.resolve();
    if (late) await launchGate.promise;
    return { terminate: stop };
  });
  runtime.registerProgram("/app", {
    adapter: "test",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    cooperative: true,
  });
  const supervisor = await (await runtime.processes()).ready();
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, {
    executable: "/app",
    argv: [],
    env: {},
    cwd: "/",
    job: 0,
    fds: [],
  });
  const starting = supervisor.start(child);
  await admitted.promise;
  if (!late) await starting;
  return { starting, release: () => launchGate.resolve() };
}

async function run(mode: string, failure: unknown) {
  const events: string[] = [];
  const ports: MessagePort[] = [];
  const backend = new MemoryBackend();
  backend.fs.writeFile("/app", new Uint8Array());
  const filesystem = new FilesystemService(backend);
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    addEventListener() {}
    postMessage(message: { connect: FilesystemConnection }) {
      ports.push(message.connect.port);
      filesystem.connect(message.connect);
    }
    terminate() {
      if (Reflect.get(globalThis, Symbol.for("waffle.runtime.owner")) === undefined)
        throw new Error("Page ownership released before filesystem stop");
      events.push("filesystem:stop");
      filesystem.dispose();
    }
  } as unknown as typeof Worker;
  try {
    return await exercise(mode, failure, events);
  } finally {
    filesystem.dispose();
    for (const port of ports) port.close();
    globalThis.Worker = originalWorker;
  }
}

async function exercise(mode: string, failure: unknown, events: string[]) {
  const originalStop = Promise.withResolvers<void>();
  const siblingStop = Promise.withResolvers<void>();
  const stopStarted = Promise.withResolvers<void>();
  const siblingStarted = Promise.withResolvers<void>();
  const siblingFailure = new Error("sibling stop failed");
  const hostJoin = mode === "host" ? originalStop.promise : Promise.resolve();
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { mode: "memory", workerURL: "https://example.test/fs.js" },
    processHost: hostFactory(events, hostJoin, mode === "host" ? stopStarted.resolve : () => {}),
  });
  const token = Reflect.get(globalThis, Symbol.for("waffle.runtime.owner"));
  const originalConsumer = {
    filesystem: runtime.filesystem.createIdentity(),
    revoke() {
      events.push("consumer:revoke");
      release();
      releaseSibling();
    },
    stop() {
      events.push("consumer:stop");
      stopStarted.resolve();
      release();
      releaseSibling();
      if (mode === "sync") throw failure;
      return originalStop.promise;
    },
  };
  const release = runtime.retainConsumer(originalConsumer);
  const releaseSibling = runtime.retainConsumer({
    filesystem: runtime.filesystem.createIdentity(),
    revoke() {
      events.push("sibling:revoke");
    },
    stop() {
      events.push("sibling:stop");
      siblingStarted.resolve();
      return siblingStop.promise;
    },
  });
  originalConsumer.stop = () => {
    throw new Error("replacement stop ran");
  };
  if (mode === "host" || mode === "adapter" || mode === "late") release();
  if (mode !== "inactive") await runtime.processes();
  const launch =
    mode === "adapter" || mode === "late"
      ? await launchAdapter(
          runtime,
          () => {
            events.push("adapter:stop");
            stopStarted.resolve();
            return originalStop.promise;
          },
          mode === "late",
        )
      : undefined;
  const disposal = runtime.dispose();
  const result = observe(disposal);
  release();
  releaseSibling();
  launch?.release();
  await launch?.starting;
  await siblingStarted.promise;
  if (mode === "host") siblingStop.resolve();
  await stopStarted.promise;
  const retainedWhilePending =
    !events.includes("filesystem:stop") &&
    Reflect.get(globalThis, Symbol.for("waffle.runtime.owner")) === token;
  if (mode === "multiple") siblingStop.reject(siblingFailure);
  else siblingStop.resolve();
  await observe(siblingStop.promise);
  if (mode === "success") originalStop.resolve();
  else if (mode !== "sync") originalStop.reject(failure);
  const settled = await result;
  const repeated = await observe(runtime.dispose());
  let guardHeld = false;
  let next: Runtime | undefined;
  try {
    next = createRuntime({
      sharedMemory: testSharedMemory,
      filesystem: { mode: "memory", workerURL: "https://example.test/fs.js" },
    });
  } catch (error) {
    guardHeld = error instanceof Error && /live page runtime/.test(error.message);
  }
  const sameToken = Reflect.get(globalThis, Symbol.for("waffle.runtime.owner")) === token;
  await next?.dispose();
  return {
    rejected: settled.status === "rejected",
    sameFailure:
      settled.status === "rejected" &&
      (mode === "multiple"
        ? settled.reason instanceof AggregateError &&
          settled.reason.errors.length === 2 &&
          Object.is(settled.reason.errors[0], failure) &&
          Object.is(settled.reason.errors[1], siblingFailure)
        : Object.is(settled.reason, failure)),
    sameRejection:
      settled.status === "rejected" &&
      repeated.status === "rejected" &&
      Object.is(settled.reason, repeated.reason),
    sameDisposal: runtime.dispose() === disposal,
    retainedWhilePending,
    guardHeld,
    sameToken,
    events,
  };
}

if (import.meta.main) {
  const result = await run(process.argv[2] ?? "consumer", failureFor(process.argv[3] ?? "error"));
  console.log(JSON.stringify(result));
}
