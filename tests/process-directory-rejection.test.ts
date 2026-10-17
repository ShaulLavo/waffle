import { afterEach, expect, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker";
import { DescriptorTable } from "../core/descriptors";
import { createFilesystemIdentity, isRevoked, revokeFilesystem } from "../fs/protocol";
import { ProcessIdentityAllocator } from "../proc/identity";
import { PipeEndpoint, PipeErrno } from "../proc/pipes";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessTable } from "../proc/table";
import { createWorkerProcessTransport, WorkerProcessClient, type WorkerProcessMessage } from "../proc/worker-client";
import { WorkerPipeHost } from "../proc/worker-pipes";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

for (const rejection of ["external", "unknown-sender"] as const) test(`rejecting a foreign directory with an admitted PID preserves the legitimate writer (${rejection})`, async () => {
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("fixture", { adapter: "fixture", module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) });
  const descriptors = new DescriptorTable();
  let broker: BrowserProcessBroker | undefined, reader: PipeEndpoint | undefined;
  cleanups.push(async () => { descriptors.dispose(); reader?.close(); await broker?.dispose(); });
  broker = new BrowserProcessBroker({ identities, table, registry,
    filesystem: { connect() { throw new Error("unused"); }, revoke: revokeFilesystem, reap: revokeFilesystem, async quiesce() {} },
    launch() { return { terminate() {} }; },
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  const rootFilesystem = createFilesystemIdentity(), childFilesystem = createFilesystemIdentity();
  root.data = { filesystem: rootFilesystem };
  await broker.adoptRuntimeRoot(root);
  const host = new WorkerPipeHost({ transport: root,
    registry: (root.data as { pipeRegistry: ConstructorParameters<typeof WorkerPipeHost>[0]["registry"] }).pipeRegistry,
    postMessage() {}, pipe: { capacity: 8, maxReaders: 8, maxWriters: 8 },
  });
  const pair = host.createPipe(); reader = pair[0];
  const fd = descriptors.open(pair[1], 1n, 1n), messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: root, descriptors, codec: host.codec(), postMessage(message) { messages.push(message); },
    prepareSpawn: () => ({ data: { filesystem: childFilesystem, pipeRegistry: host.registry.handle() } }),
  });
  const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [{ child: 1, parent: fd }] };
  const pid = client.spawn(client.pid, request);
  descriptors.close(fd);
  const message = messages.shift()!;
  await broker.runtimeMessage(message, client.pid);
  const supervisor = await broker.ready(); await supervisor.start(pid);
  const writer = supervisor.get(pid)!.descriptors.get(1)!.resource as PipeEndpoint;
  const lifetime = new Int32Array((message.transport.resources[0] as { endpoint: { lifetime: SharedArrayBuffer } }).endpoint.lifetime);
  expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);

  // A separate directory and allocator may reuse numeric PIDs; they confer no authority
  // over the runtime's admitted directory or its pipe publication rows.
  const foreignIdentities = new ProcessIdentityAllocator(), foreignDescriptors = new DescriptorTable();
  cleanups.push(() => { foreignDescriptors.dispose(); });
  const foreignRoot = createWorkerProcessTransport({ pid: foreignIdentities.pid(), job: foreignIdentities.job(), identity: foreignIdentities.buffer });
  const foreignFilesystem = createFilesystemIdentity(), foreignMessages: WorkerProcessMessage[] = [];
  const foreignClient = new WorkerProcessClient({ transport: foreignRoot, descriptors: foreignDescriptors, codec: host.codec(),
    postMessage(message) { foreignMessages.push(message); }, prepareSpawn: () => ({ data: { filesystem: foreignFilesystem } }),
  });
  const foreignPid = foreignClient.spawn(foreignClient.pid, { ...request, fds: [] });
  expect(foreignPid).toBe(pid);
  const rejected = foreignMessages.shift()!;
  if (rejection === "external") broker.rejectRuntimeMessage(rejected, client.pid);
  else await broker.runtimeMessage(rejected, client.pid + 1000);

  expect(isRevoked(rootFilesystem)).toBe(false);
  expect(isRevoked(childFilesystem)).toBe(false);
  expect(isRevoked(foreignFilesystem)).toBe(true);
  expect(Atomics.load(lifetime, 0)).toBe(0);
  expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  expect(writer.tryWrite([new Uint8Array([68])])).toBe(1);
  const bytes = new Uint8Array(1);
  expect(reader.tryRead([bytes])).toBe(1); expect(bytes[0]).toBe(68);
});
