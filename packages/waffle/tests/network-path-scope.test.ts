import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createRuntime,
  type ProcessService,
  type Runtime,
  type RuntimeProcessContext,
} from "../index.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";

const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
let runtime: Runtime;
let tables: DescriptorTable[];
beforeEach(() => {
  tables = [];
  runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  });
});
afterEach(async () => {
  await runtime.dispose();
  for (const table of tables) table.dispose();
});

/** A runtime root that spawns through the real broker, so children have admitted transports. */
async function spawnFromRoot(executable: string) {
  await runtime.filesystem.writeFile(executable, new Uint8Array());
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  await service.adoptRuntimeRoot(transport, { output: () => {} });
  const notices: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  tables.push(descriptors);
  const childFilesystem = runtime.filesystem.createIdentity();
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: createWorkerPipeCodec(),
    prepareSpawn: () => ({ data: { filesystem: childFilesystem } }),
    postMessage: (message) => notices.push(message),
  });
  const supervisor = await service.ready();
  const pid = transport.pid;
  const child = client.spawn(pid, { executable, argv: [], env: {}, cwd: "/", job: -1, fds: [] });
  while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
  await supervisor.start(child);
  return { service, supervisor, childFilesystem };
}

test("a launcher pairs its live admitted context with a directory, and only that context", async () => {
  const seen: { context: RuntimeProcessContext; service: ProcessService }[] = [];
  runtime.registerAdapter("test", (context, service) => {
    seen.push({ context, service });
    return { terminate() {} };
  });
  runtime.registerProgram("/app", { adapter: "test", module: emptyModule, cooperative: true });
  const { childFilesystem } = await spawnFromRoot("/app");
  const [{ context, service }] = seen;
  const scope = service.networkPathScope(context!, 5);
  expect(scope.filesystem).toBe(childFilesystem);
  expect(scope.directory).toBe(5);
  expect(Object.isFrozen(scope)).toBe(true);
  expect(() => service.networkPathScope({ ...context!, job: context!.job + 1 }, 5)).toThrow(
    /does not match/,
  );
  expect(() => service.networkPathScope({ ...context!, pid: 99_999 }, 5)).toThrow(/no admitted/);
  expect(() => service.networkPathScope(context!, -1)).toThrow(TypeError);
  runtime.filesystem.revoke(childFilesystem);
  expect(() => service.networkPathScope(context!, 5)).toThrow(/revoked/);
});

test("an exited context cannot be paired", async () => {
  const seen: { context: RuntimeProcessContext; service: ProcessService }[] = [];
  runtime.registerAdapter("test", (context, service) => {
    seen.push({ context, service });
    return { terminate() {} };
  });
  runtime.registerProgram("/app", { adapter: "test", module: emptyModule, cooperative: true });
  await spawnFromRoot("/app");
  const [{ context, service }] = seen;
  context!.exit(0);
  expect(() => service.networkPathScope(context!, 5)).toThrow();
});
