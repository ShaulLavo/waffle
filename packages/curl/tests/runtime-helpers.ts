import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import { createRuntime, type Runtime } from "../../waffle/index.ts";
import { DescriptorTable } from "../../waffle/core/descriptors.ts";
import { PipeController, type PipeEndpoint } from "../../waffle/proc/pipes.ts";
import { createRuntimeTerminalCodec } from "../../waffle/browser/runtime-terminals.ts";
import { createWorkerPipeCodec } from "../../waffle/proc/worker-pipes.ts";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../../waffle/proc/worker-client.ts";
import type { HostCommandContext } from "../../waffle/proc/command.ts";
import type { CurlPackageFiles } from "../src/index.ts";

const cleanups: Array<() => void | Promise<void>> = [];
const gates: Array<() => void> = [];
const owners: Runtime[] = [];

export async function cleanupRuntime(): Promise<void> {
  for (const release of gates.splice(0)) release();
  for (const runtime of owners.splice(0)) await runtime.dispose();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export function deferred() {
  const gate = Promise.withResolvers<void>();
  gates.push(gate.resolve);
  return gate;
}

export function runtime() {
  const owner = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  owners.push(owner);
  return owner;
}

export async function shell(runtime: Runtime) {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  await service.adoptRuntimeRoot(transport, {
    memory: [],
    output: (fd, bytes) => (fd === 2 ? stderr : stdout).push(bytes.slice()),
  });
  const descriptors = new DescriptorTable();
  cleanups.push(() => descriptors.dispose());
  const io = {
    kind: "terminal" as const,
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
  descriptors.openAt(1, io, 64n, 0n);
  descriptors.openAt(2, { ...io }, 64n, 0n);
  const notices: WorkerProcessMessage[] = [];
  const codec = createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() });
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec,
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    postMessage: (message) => notices.push(message),
  });
  const supervisor = await service.ready();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, transport.pid);
  };
  return {
    service,
    supervisor,
    descriptors,
    root: transport.pid,
    stdout,
    stderr,
    async spawn(
      executable: string,
      args: string[] = [],
      cwd = "/",
      fds = [
        { parent: 1, child: 1 },
        { parent: 2, child: 2 },
      ],
    ) {
      const pid = client.spawn(transport.pid, {
        executable,
        argv: [executable].concat(args),
        cwd,
        env: {},
        job: -1,
        fds,
      });
      await flush();
      const exit = supervisor.waitForExit(transport.pid, pid);
      await supervisor.start(pid);
      return {
        pid,
        exit,
        async collect() {
          const result = await exit;
          client.wait(transport.pid, pid);
          await flush();
          return result;
        },
      };
    },
  };
}

export function pipe(pid: number) {
  const controller = new PipeController({ capacity: 4096, relay: "manual" });
  const reader = controller.retain(pid, "read");
  const writer = controller.retain(pid, "write");
  cleanups.push(
    () => controller.dispose(),
    () => reader.close(),
    () => writer.close(),
  );
  return {
    reader,
    writer,
    writerFor(process: number) {
      const endpoint = controller.retain(process, "write");
      cleanups.push(() => endpoint.close());
      return endpoint;
    },
  };
}

export async function writePipe(writer: PipeEndpoint, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writer.tryWrite([bytes.subarray(offset, offset + 4096)]);
    if (count === -6) {
      await writer.waitWritable();
      continue;
    }
    if (count <= 0) throw new Error(`pipe write failed: ${count}`);
    offset += count;
  }
  writer.close();
}

export async function readPipe(reader: PipeEndpoint): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const bytes = new Uint8Array(4096);
    const count = reader.tryRead([bytes]);
    if (count === -6) {
      await reader.waitReadable();
      continue;
    }
    if (count < 0) throw new Error(`pipe read failed: ${count}`);
    if (!count) return Buffer.concat(chunks);
    chunks.push(bytes.subarray(0, count));
  }
}

/** A test-only page-owned memory filesystem grant, never a host filesystem bridge. */
export function files(owner: Runtime) {
  const events: string[] = [];
  const paths: { path: string; cwd: string }[] = [];
  const capabilities: CurlPackageFiles = {
    async read({ path, cwd, signal }) {
      paths.push({ path, cwd });
      signal.throwIfAborted();
      const bytes = await owner.filesystem.readFile(path.startsWith("/") ? path : `${cwd}/${path}`);
      signal.throwIfAborted();
      if (!bytes) throw new Error("missing fixture input");
      return new Blob([bytes.slice()]).stream();
    },
    async write({ path, cwd, signal }) {
      paths.push({ path, cwd });
      const target = path.startsWith("/") ? path : `${cwd}/${path}`;
      signal.throwIfAborted();
      await owner.filesystem.writeFile(target, new Uint8Array());
      return {
        async write(bytes, abort) {
          abort.throwIfAborted();
          await owner.filesystem.writeFile(target, bytes, true);
          events.push("write");
          abort.throwIfAborted();
        },
        async close(abort) {
          abort.throwIfAborted();
          events.push("close");
        },
        async abort() {
          // Committed partial bytes remain; there is no pending file request after write settles.
          events.push("abort");
        },
      };
    },
  };
  return { capabilities, events, paths };
}

export function observeStdout(
  context: HostCommandContext,
  entered: () => void,
): HostCommandContext {
  return {
    ...context,
    stdout: {
      write(bytes) {
        entered();
        return context.stdout.write(bytes);
      },
    },
  };
}
