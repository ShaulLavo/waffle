import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Runtime } from "../../runtime.js";
import type { WorkerProcessMessage } from "../../proc/worker-client.js";
import { pieCore } from "./memory-group-pie.js";

const root = process.argv[2]!;
const fallback = process.argv[3] === "fallback";
const scratch = await mkdtemp(join(tmpdir(), "waffle-parity-"));
const events: {
  realm: string;
  purpose: string;
  constructor: string;
  descriptor: unknown;
  outcome: string;
  rawURL?: string;
}[] = [];
const nativeShared = SharedArrayBuffer;
const nativeMemory = WebAssembly.Memory;
const nativeWorker = Worker;
const owned: Worker[] = [];
const fixtureHashes: Record<string, string> = {};
let phase = "startup";
function record(constructor: string, descriptor: unknown, outcome: string, rawURL?: string) {
  events.push({
    realm: "page-owned-javascript",
    purpose: phase,
    constructor,
    descriptor: structuredClone(descriptor),
    outcome,
    ...(rawURL ? { rawURL } : {}),
  });
}
globalThis.SharedArrayBuffer = new Proxy(nativeShared, {
  construct(target, args) {
    const maximum = args[1]?.maxByteLength;
    const descriptor = {
      initial: args[0],
      maximum: maximum ?? args[0],
      growable: maximum !== undefined,
    };
    record("SharedArrayBuffer", descriptor, "attempt");
    if (fallback && maximum === 2147479552) {
      record("SharedArrayBuffer", descriptor, "arena-fallback-refusal");
      throw new RangeError("pinned per-object fallback control");
    }
    try {
      const value = Reflect.construct(target, args);
      record("SharedArrayBuffer", descriptor, "success");
      return value;
    } catch (error) {
      record("SharedArrayBuffer", descriptor, "native-refusal");
      throw error;
    }
  },
});
WebAssembly.Memory = new Proxy(nativeMemory, {
  construct(target, args) {
    record("WebAssembly.Memory", args[0], "attempt");
    try {
      const value = Reflect.construct(target, args);
      record("WebAssembly.Memory", args[0], "success");
      return value;
    } catch (error) {
      record("WebAssembly.Memory", args[0], "native-refusal");
      throw error;
    }
  },
});
globalThis.Worker = new Proxy(nativeWorker, {
  construct(target, args) {
    const raw = String(args[0]);
    const url = new URL(raw);
    const purpose =
      raw === "https://fixture.invalid/fs-worker.js"
        ? "filesystem-worker"
        : raw === pathToFileURL(join(scratch, "guest.ts")).href
          ? "guest-worker"
          : "unknown-worker";
    const descriptor = {
      url: purpose === "unknown-worker" ? raw : purpose,
      options: args[1] ?? null,
    };
    record("Worker", descriptor, "attempt", raw);
    const actual =
      purpose === "filesystem-worker"
        ? new URL("browser/fs-worker.ts", pathToFileURL(root + "/"))
        : url;
    const worker = Reflect.construct(target, [actual, args[1]]);
    owned.push(worker);
    record("Worker", descriptor, "success", raw);
    return worker;
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Bun parity desktop", maxTouchPoints: 0 },
});
Object.assign(globalThis, { location: new URL("https://fixture.invalid/") });
const url = (path: string) => pathToFileURL(join(root, path)).href;
let runtime: { dispose(): Promise<void> } | undefined;
const ports: MessagePort[] = [];
try {
  await writeFile(
    join(scratch, "guest.ts"),
    `import {bootstrap,preview1Executor} from ${JSON.stringify(url("browser/worker.ts"))};import{linkedWorkerHooks}from ${JSON.stringify(url("link/index.ts"))};globalThis.onmessage=({data})=>bootstrap(data,data.linkPlan?{...linkedWorkerHooks(),namespaces:()=>({tst:{check(){}}}),run:(_c,exit)=>exit??0}:preview1Executor);`,
  );
  const { createRuntime } = await import(url("runtime.ts"));
  const active: Runtime = createRuntime({ filesystem: { mode: "memory" } });
  runtime = active;
  await active.filesystem.writeFile(
    "/guest",
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 1, 1, 2, 7, 19, 2, 6,
      109, 101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
    ]),
  );
  phase = "fork";
  const fork = active.filesystem.fork();
  ports.push(fork.port);
  phase = "connection";
  const connection = active.filesystem.connect(active.filesystem.createIdentity());
  ports.push(connection.port);
  const { prepareLinkPlan } = await import(url("link/index.ts"));
  const groupSource = pieCore([]);
  const importPattern = [3, 101, 110, 118, 5, 99, 104, 101, 99, 107];
  const checkpoint = groupSource.findIndex((_, index) =>
    importPattern.every((byte, offset) => groupSource[index + offset] === byte),
  );
  assert(checkpoint >= 0);
  groupSource.set([116, 115, 116], checkpoint + 1);
  const groupPlan = await prepareLinkPlan({
    core: {
      id: "pinned",
      source: groupSource,
      cooperative: true,
      checkpoint: { module: "tst", name: "check" },
      initializeMemory: [],
      initialize: [],
    },
    libraries: [],
    reserve: "reserve",
  });
  await active.filesystem.writeFile("/group", groupSource);
  active.registerAdapter("pinned", (context, service) =>
    service.launchWorker(context, {
      workerUrl: pathToFileURL(join(scratch, "guest.ts")).href,
      request: {
        module: context.module,
        args: [],
        env: {},
        ...(context.request.argv[0] === "group" ? { linkPlan: groupPlan.toSource() } : {}),
      },
      ...(context.request.argv[0] === "group" ? { memoryGroup: "new" as const } : {}),
    }),
  );
  const guestSource = await active.filesystem.readFile("/guest");
  assert(guestSource);
  fixtureHashes.guest = createHash("sha256").update(guestSource).digest("hex");
  fixtureHashes.group = createHash("sha256").update(groupSource).digest("hex");
  active.registerProgram("/guest", { adapter: "pinned", source: guestSource });
  active.registerProgram("/group", {
    adapter: "pinned",
    module: groupPlan.entryModule,
    cooperative: true,
  });
  const { createWorkerProcessTransport, WorkerProcessClient } = await import(
    url("proc/worker-client.ts")
  );
  const { DescriptorTable } = await import(url("core/descriptors.ts"));
  const rootTransport = createWorkerProcessTransport({
    pid: active.identities.pid(),
    job: active.identities.job(),
    identity: active.identities.buffer,
  });
  rootTransport.data = { filesystem: active.filesystem.createIdentity() };
  const notices: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  const unused = () => {
    throw new Error("unexpected descriptor transfer");
  };
  const client = new WorkerProcessClient({
    transport: rootTransport,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message: WorkerProcessMessage) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: active.filesystem.createIdentity() } }),
  });
  const service = await active.processes();
  await service.adoptRuntimeRoot(rootTransport, { memory: [] });
  const supervisor = await service.ready();
  const parent = rootTransport.pid;
  for (const purpose of ["guest", "group"]) {
    phase = purpose;
    const pid = client.spawn(parent, {
      executable: purpose === "group" ? "/group" : "/guest",
      argv: [purpose],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    while (notices.length) await service.runtimeMessage(notices.shift()!, parent);
    await supervisor.start(pid);
    const exit = await supervisor.waitForExit(parent, pid);
    assert.equal(exit.status, 0, purpose + JSON.stringify(exit));
    supervisor.reap(parent, pid);
  }
  descriptors.dispose();
  phase = "dispose";
} finally {
  await runtime?.dispose();
  await Promise.all(owned.map((worker) => worker.terminate()));
  for (const port of ports) port.close();
  await rm(scratch, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    boundary: "PRE-IMPORT PAGE-OWNED JavaScript",
    fallback,
    fixtures: fixtureHashes,
    events,
  }),
);
