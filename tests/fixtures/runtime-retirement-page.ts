import { createRuntime, type Runtime, type RuntimeOptions } from "../../runtime.js";
import { BrowserProcessBroker } from "../../browser/process-broker.js";
import { MemoryBackend } from "../../fs/backend.js";
import { FilesystemService } from "../../fs/service.js";
import { FilesystemSection, isRevoked } from "../../fs/protocol.js";
import { ProcessSupervisor } from "../../proc/supervisor.js";

const mode = process.argv[2];
const backend = new MemoryBackend();
backend.fs.writeFile("/app", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const service = new FilesystemService(backend);
const ports: MessagePort[] = [];
const stops: string[] = [];
const failures = [new Error("original first stop"), new Error("original second stop")];
const previousWorker = globalThis.Worker;
let filesystemStops = 0;
let hostStops = 0;
let hostEmpty = false;
let stopInsideSection = false;
let active = false;
let releaseFirst!: () => void;
const firstGate = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});

globalThis.Worker = class {
  addEventListener() {}
  postMessage(message: { connect: Parameters<FilesystemService["connect"]>[0] }) {
    ports.push(message.connect.port);
    service.connect(message.connect);
  }
  terminate() {
    filesystemStops++;
    service.dispose();
  }
} as unknown as typeof Worker;

const processHost: NonNullable<RuntimeOptions["processHost"]> = (options) => {
  if (mode === "host") {
    const host = new BrowserProcessBroker({ ...options, onError() {} });
    const dispose = host.dispose.bind(host);
    host.dispose = async () => {
      hostStops++;
      await dispose();
      hostEmpty = options.table.values().next().done === true;
      throw failures[0];
    };
    return host;
  }
  const supervisor = new ProcessSupervisor({
    registry: options.registry,
    table: options.table,
    launch: options.launch,
  });
  return {
    ready: async () => supervisor,
    suspend: () => supervisor.dispose(),
    quiesce: async () => {},
    dispose: async () => {
      hostStops++;
    },
  } as Awaited<ReturnType<NonNullable<RuntimeOptions["processHost"]>>>;
};

function retain(runtime: Runtime, label: string, fail: boolean, delayed = false) {
  const identity = runtime.filesystem.createIdentity();
  let unregister = () => {};
  unregister = runtime.retainConsumer({
    filesystem: identity,
    revoke() {
      unregister();
    },
    async stop() {
      unregister();
      stops.push(label);
      stopInsideSection ||= active;
      if (!isRevoked(identity)) throw new Error("stop preceded revocation");
      if (delayed) await firstGate;
      if (label === "second") releaseFirst();
      if (fail) throw failures[label === "first" ? 0 : 1];
    },
  });
  return identity;
}

async function lateHandle(runtime: Runtime) {
  let entered!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.registerAdapter("late", async () => {
    entered();
    await gate;
    return {
      terminate() {
        stops.push("handle");
        throw failures[0];
      },
    };
  });
  runtime.registerProgram("/app", {
    adapter: "late",
    cooperative: true,
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
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
  await admitted;
  return { release, starting };
}

async function run() {
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: "https://example.test/stand-in.js" },
    processHost,
  });
  const token = Reflect.get(globalThis, Symbol.for("waffle.runtime.owner"));
  let identity;
  if (mode === "consumer" || mode === "success")
    identity = retain(runtime, "first", mode !== "success");
  if (mode === "siblings") {
    identity = retain(runtime, "first", false);
    retain(runtime, "second", true);
  }
  if (mode === "multiple") {
    identity = retain(runtime, "first", true, true);
    retain(runtime, "second", true);
  }
  if (mode === "host") await runtime.processes();
  const late = mode === "late" ? await lateHandle(runtime) : undefined;
  const section = identity ? new FilesystemSection(identity) : undefined;
  section?.enter();
  active = section !== undefined;
  const disposal = runtime.dispose();
  const sameDisposal = runtime.dispose() === disposal;
  const synchronousDisposed = runtime.disposed;
  await Promise.resolve();
  const stopsBeforeFence = stops.length;
  active = false;
  section?.exit();
  late?.release();
  await late?.starting;
  let rejected: unknown;
  try {
    await disposal;
  } catch (error) {
    rejected = error;
  }
  const originals = rejected instanceof AggregateError ? rejected.errors : [rejected];
  let methodsClosed = false;
  try {
    runtime.filesystem.createIdentity();
  } catch {
    methodsClosed = true;
  }
  return {
    mode,
    filesystemStops,
    hostStops,
    hostEmpty,
    stops,
    stopsBeforeFence,
    stopInsideSection,
    sameDisposal,
    synchronousDisposed,
    methodsClosed,
    originalFailures: originals.map((error) => failures.indexOf(error)),
    guardHeld: Reflect.get(globalThis, Symbol.for("waffle.runtime.owner")) === token,
    filesystemDisposed: runtime.filesystem.state.status === "disposed",
  };
}

try {
  console.log(JSON.stringify(await run()));
} finally {
  service.dispose();
  for (const port of ports) port.close();
  globalThis.Worker = previousWorker;
}
process.exit(0);
