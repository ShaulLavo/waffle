import { standaloneRuntimeProcess } from "./fixtures/standalone-runtime-process.js";
import { testSharedMemory } from "./fixtures/shared-memory-platform.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createProcessIdentity,
  snapshotHostIdentity,
  type RuntimeProcessIdentity,
} from "../browser/process-context.js";

test("host identity is explicit and snapshotted without Unix defaults", () => {
  expect(snapshotHostIdentity(undefined)).toBeNull();
  expect(snapshotHostIdentity(null)).toBeNull();
  const source = { uid: 4001, euid: 5002, hostname: "fixture.example" };
  const identity = snapshotHostIdentity(source);
  source.uid = 0;
  source.euid = 0;
  source.hostname = "forged.example";
  expect(identity).toEqual({ uid: 4001, euid: 5002, hostname: "fixture.example" });
  expect(Object.isFrozen(identity)).toBe(true);
});

test("invalid host identity is rejected instead of normalized", () => {
  const base = { uid: 4001, euid: 5002, hostname: "fixture.example" };
  for (const value of [-1, 1.5, NaN, Infinity, 0xffff_ffff]) {
    expect(() => snapshotHostIdentity({ ...base, uid: value })).toThrow(TypeError);
    expect(() => snapshotHostIdentity({ ...base, euid: value })).toThrow(TypeError);
  }
  for (const hostname of ["", "foo\0bar", "foo\nbar", "foo bar", "foo\x7fbar"])
    expect(() => snapshotHostIdentity({ ...base, hostname })).toThrow(TypeError);
  expect(snapshotHostIdentity({ uid: 0, euid: 0, hostname: "configured-root" })).toEqual({
    uid: 0,
    euid: 0,
    hostname: "configured-root",
  });
});

test("process identity uses supplied ancestry and preserves unsupported host identity", () => {
  const ancestry = { pid: 70, parentPid: 35 };
  const identity = createProcessIdentity(ancestry);
  ancestry.parentPid = 0;
  expect(identity).toEqual({ pid: 70, parentPid: 35, host: null });
  expect(Object.isFrozen(identity)).toBe(true);
  expect(createProcessIdentity({ pid: 70, parentPid: 0 }).parentPid).toBe(0);
  for (const pid of [0, -1, 1.5, NaN, 0x8000_0000])
    expect(() => createProcessIdentity({ pid, parentPid: 0 })).toThrow(TypeError);
  for (const parentPid of [-1, 1.5, NaN, 70, 0x8000_0000])
    expect(() => createProcessIdentity({ pid: 70, parentPid })).toThrow(TypeError);
});

import { createRuntime, type Runtime, type RuntimeHostIdentity } from "../index.js";
import {
  bootstrap,
  preview1Executor,
  type RuntimeWorkerMessage,
  type RuntimeWorkerRequest,
} from "../browser/worker.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { FilesystemService } from "../fs/service.js";
import { MemoryBackend } from "../fs/backend.js";
import type { FilesystemConnection } from "../fs/protocol.js";
import { processContextGuest } from "./fixtures/process-context-guest.js";

const nativeWorker = globalThis.Worker;
let runtime: Runtime | undefined;
let ports: MessagePort[];
let requests: RuntimeWorkerRequest[];
let entered: RuntimeProcessIdentity[];
let observations: number[][];
let completions: Promise<void>[];
let launches: number;
let descriptorTables: DescriptorTable[];

class IdentityFixtureWorker {
  onmessage: ((event: { data: RuntimeWorkerMessage }) => void) | null = null;
  onerror = null;
  private service?: FilesystemService;
  constructor(url: string) {
    launches++;
    if (!url.endsWith("filesystem.js")) return;
    const backend = new MemoryBackend();
    backend.fs.writeFile("/app", new Uint8Array());
    this.service = new FilesystemService(backend);
  }
  addEventListener() {}
  postMessage(message: { connect: FilesystemConnection } | RuntimeWorkerRequest) {
    if ("connect" in message) {
      ports.push(message.connect.port);
      this.service!.connect(message.connect);
      return;
    }
    requests.push(message);
    ports.push(message.filesystem.port);
    completions.push(this.execute(message));
  }
  private async execute(request: RuntimeWorkerRequest) {
    await bootstrap(
      request,
      {
        setup({ fs, identity }) {
          if (identity) entered.push(identity);
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
        },
        namespaces({ identity }) {
          const host = identity?.host;
          return {
            identity_fixture: {
              uid: () => host?.uid ?? -58,
              euid: () => host?.euid ?? -58,
              parent_pid: () => identity?.parentPid ?? -58,
              hostname_byte: (index: number) =>
                host ? new TextEncoder().encode(host.hostname)[index]! : -58,
            },
          };
        },
        run(context, exited) {
          const code = preview1Executor.run(context, exited);
          const memory = context.instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing guest memory");
          observations.push(Array.from(new Uint32Array(memory.buffer, 0, 4)));
          return code;
        },
      },
      {
        crossOriginIsolated: true,
        postMessage: (data) => this.onmessage?.({ data }),
      },
    );
  }
  terminate() {
    this.service?.dispose();
  }
}

beforeEach(() => {
  ports = [];
  requests = [];
  entered = [];
  observations = [];
  completions = [];
  launches = 0;
  descriptorTables = [];
  globalThis.Worker = IdentityFixtureWorker as unknown as typeof Worker;
});

afterEach(async () => {
  try {
    await runtime?.dispose();
    await Promise.all(completions);
  } finally {
    runtime = undefined;
    for (const table of descriptorTables) table.dispose();
    for (const port of ports) port.close();
    globalThis.Worker = nativeWorker;
  }
});

function page(hostIdentity?: RuntimeHostIdentity) {
  runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { mode: "memory", workerURL: "https://fixture.test/filesystem.js" },
    hostIdentity,
  });
  return runtime;
}

async function runChild(hostIdentity?: RuntimeHostIdentity) {
  const owner = page(hostIdentity);
  const adapterContexts: RuntimeProcessIdentity[] = [];
  owner.registerAdapter("identity", (context, service) => {
    adapterContexts.push(context.identity);
    const request = {
      module: context.module,
      args: context.request.argv,
      env: context.request.env,
      hostIdentity: { uid: 0, euid: 0, hostname: "adapter-forgery" },
    };
    return service.launchWorker(context, {
      workerUrl: "https://fixture.test/identity-guest.js",
      request,
    });
  });
  owner.registerProgram("/app", {
    adapter: "identity",
    module: processContextGuest,
    cooperative: true,
  });
  const service = await owner.processes();
  const transport = createWorkerProcessTransport({
    pid: owner.identities.pid(),
    job: owner.identities.job(),
    identity: owner.identities.buffer,
  });
  transport.data = { filesystem: owner.filesystem.createIdentity() };
  await service.adoptRuntimeRoot(transport, { memory: [] });
  const root = transport.pid;
  const descriptors = new DescriptorTable();
  descriptorTables.push(descriptors);
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: {
      export() {
        throw new Error("unused");
      },
      import() {
        throw new Error("unused");
      },
      discard() {},
    },
    prepareSpawn: () => ({ data: { filesystem: owner.filesystem.createIdentity() } }),
    postMessage: (message) => notices.push(message),
  });
  const child = client.spawn(root, {
    executable: "/app",
    argv: [],
    cwd: "/",
    job: 0,
    fds: [],
    env: { UID: "0", EUID: "0", HOSTNAME: "env-forgery", PPID: "999" },
  });
  const notice = notices.find((message) => message.operation === "spawn");
  if (!notice) throw new Error("missing child spawn notice");
  await service.runtimeMessage(notice, root);
  const supervisor = await service.ready();
  await supervisor.start(child);
  const exit = await supervisor.waitForExit(root, child);
  descriptors.dispose();
  expect(exit).toMatchObject({ kind: "exited", code: 0 });
  await Promise.all(completions);
  return { root, child, adapterContexts };
}

test("page identity stays immutable before lazy process activation", () => {
  const source = { uid: 4001, euid: 5002, hostname: "fixture.example" };
  const owner = page(source);
  source.uid = 0;
  source.hostname = "changed.example";
  expect(owner.hostIdentity).toEqual({ uid: 4001, euid: 5002, hostname: "fixture.example" });
  expect(Object.isFrozen(owner.hostIdentity)).toBe(true);
  expect(launches).toBe(1);
});

test("invalid page identity fails before allocating filesystem workers and releases ownership", () => {
  expect(() => page({ uid: -1, euid: 5, hostname: "fixture.example" })).toThrow(TypeError);
  expect(launches).toBe(0);
  expect(page().hostIdentity).toBeNull();
});

test.each([
  { uid: 4001, euid: 5002, hostname: "alpha.example" },
  { uid: 6003, euid: 7004, hostname: "beta.example" },
])(
  "guest reads configured identity and actual parent, not adapter or env forgery: %j",
  async (host) => {
    const { root, child, adapterContexts } = await runChild(host);
    expect(entered).toEqual([{ pid: child, parentPid: root, host }]);
    expect(adapterContexts).toEqual(entered);
    expect(requests[0]!.hostIdentity).toEqual(host);
    expect(observations).toEqual([[host.uid, host.euid, root, host.hostname.charCodeAt(0)]]);
  },
);

test("unconfigured page preserves ancestry but guest host metadata is unsupported", async () => {
  const { root, child } = await runChild();
  expect(entered).toEqual([{ pid: child, parentPid: root, host: null }]);
  expect(requests[0]!.hostIdentity).toBeNull();
  expect(observations).toEqual([[0xffff_ffc6, 0xffff_ffc6, root, 0xffff_ffc6]]);
});

test("externally launched roots use the page snapshot and their actual zero parent", async () => {
  const hostIdentity = { uid: 8005, euid: 9006, hostname: "root.example" };
  const owner = page(hostIdentity);
  const transport = createWorkerProcessTransport({
    pid: owner.identities.pid(),
    job: owner.identities.job(),
    identity: owner.identities.buffer,
  });
  const worker = new IdentityFixtureWorker("identity-guest.js");
  worker.postMessage({
    controlGrant: { kind: "unbounded" },
    module: processContextGuest,
    args: [],
    env: {},
    filesystem: owner.filesystem.fork(),
    runtimeProcess: standaloneRuntimeProcess(transport),
    hostIdentity: owner.hostIdentity,
  });
  await Promise.all(completions);
  expect(entered).toEqual([{ pid: transport.pid, parentPid: 0, host: hostIdentity }]);
  expect(observations).toEqual([[8005, 9006, 0, "r".charCodeAt(0)]]);
});

test("bootstrap does not invent process identity without an admitted transport", async () => {
  const owner = page({ uid: 4001, euid: 5002, hostname: "fixture.example" });
  const connection = owner.filesystem.fork();
  ports.push(connection.port);
  let observed = false;
  await bootstrap(
    {
      controlGrant: { kind: "unbounded" },
      module: processContextGuest,
      args: [],
      env: {},
      filesystem: connection,
      hostIdentity: owner.hostIdentity,
    },
    {
      setup(context) {
        observed = true;
        expect(context.identity).toBeNull();
        context.finish({ code: 0 });
      },
      run() {
        throw new Error("setup finishes before guest entry");
      },
    },
    { crossOriginIsolated: true, postMessage() {} },
  );
  expect(observed).toBe(true);
});
