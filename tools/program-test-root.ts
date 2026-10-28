import type { Runtime } from "waffle";
import type { SpawnRequest } from "waffle/proc/types";
import { DescriptorTable } from "waffle/core/descriptors";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import { PipePublicationRegistry } from "waffle/proc/pipes";
import {
  createWorkerProcessTransport,
  workerProcessState,
  WorkerProcessClient,
  type WorkerProcessMessage,
  type WorkerSpawnTransfer,
} from "waffle/proc/worker-client";

export type TestExecution = { status: number; stdout: string; stderr: string };
export type TestRequest = Pick<SpawnRequest, "executable" | "argv" | "env" | "cwd"> & {
  readonly input?: string;
};

type InputNotice = { kind: "input"; message: WorkerProcessMessage };
type Notice = InputNotice | { kind: "process"; message: WorkerProcessMessage };
type InputBinding = { fd: number; announcement: InputNotice };

function discardNotice(notices: Notice[], announcement: InputNotice) {
  const index = notices.indexOf(announcement);
  if (index !== -1) notices.splice(index, 1);
}

function discardOwnedNotices(notices: Notice[]) {
  for (let index = notices.length - 1; index >= 0; index--) {
    if (notices[index]?.kind === "input") notices.splice(index, 1);
  }
}

function decode(chunks: readonly Uint8Array[]) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function inputPipe(
  pipes: WorkerPipeHost,
  descriptors: DescriptorTable,
  notices: Notice[],
  input: string,
): InputBinding {
  const [reader, writer] = pipes.createPipe();
  const announcement = notices.at(-1);
  const bytes = new TextEncoder().encode(input);
  try {
    if (announcement?.kind !== "input") throw new Error("Missing input pipe announcement");
    if (writer.write([bytes]) !== bytes.length) throw new Error("Short test stdin write");
    return {
      fd: descriptors.open(reader, (1n << 1n) | (1n << 21n) | (1n << 27n), 0n),
      announcement,
    };
  } catch (error) {
    reader.close();
    if (announcement?.kind === "input") discardNotice(notices, announcement);
    throw error;
  } finally {
    writer.close();
  }
}

function releaseInput(
  descriptors: DescriptorTable,
  input: InputBinding | undefined,
  notices: Notice[],
  canceled: boolean,
) {
  if (!input) return;
  try {
    descriptors.close(input.fd);
  } finally {
    if (canceled) discardNotice(notices, input.announcement);
  }
}

function preparePipeChild(
  runtime: Runtime,
  pipes: WorkerPipeHost,
  child: number,
): WorkerSpawnTransfer {
  let enrolled = false;
  const cancel = () => {
    if (!enrolled) return;
    pipes.registry.collectProcess(child);
    enrolled = false;
  };
  try {
    pipes.registry.registerProcess(child);
    enrolled = true;
    return {
      data: {
        filesystem: runtime.filesystem.createIdentity(),
        pipeRegistry: pipes.registry.handle(),
      },
      cancel,
    };
  } catch (error) {
    cancel();
    throw error;
  }
}

/** Test-only page/root controller; all process, descriptor and worker behavior is Waffle's. */
export async function createProgramTestRoot(runtime: Runtime) {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  const registry = new PipePublicationRegistry({ wake: workerProcessState(transport).wake });
  const pipeRegistry = registry.handle();
  transport.data = { filesystem: runtime.filesystem.createIdentity(), pipeRegistry };
  const output = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
  await service.adoptRuntimeRoot(transport, {
    output: (fd, data) => (fd === 2 ? output.stderr : output.stdout).push(data.slice()),
  });
  const supervisor = await service.ready();
  const descriptors = new DescriptorTable();
  for (const fd of [0, 1, 2]) {
    descriptors.openAt(
      fd,
      {
        kind: "terminal",
        read: () => 0,
        write: (chunks) => chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        readiness: () => ({ readable: true, writable: true, hangup: fd === 0 }),
      },
      (fd === 0 ? 1n << 1n : 1n << 6n) | (1n << 21n) | (1n << 27n),
      0n,
    );
  }
  const notices: Notice[] = [];
  const pipes = new WorkerPipeHost({
    transport,
    registry: pipeRegistry,
    postMessage: (message) => notices.push({ kind: "input", message }),
  });
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: createRuntimeTerminalCodec({ descriptors, fallback: pipes.codec() }),
    prepareSpawn: (child) => preparePipeChild(runtime, pipes, child),
    postMessage: (message) => notices.push({ kind: "process", message }),
  });
  const active = new Set<number>();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!.message, transport.pid);
  };
  const spawn = (request: TestRequest) => {
    const input =
      request.input === undefined
        ? undefined
        : inputPipe(pipes, descriptors, notices, request.input);
    let reserved = false;
    try {
      const child = client.spawn(transport.pid, {
        executable: request.executable,
        argv: request.argv,
        env: request.env,
        cwd: request.cwd,
        job: -1,
        fds: [0, 1, 2].map((fd) => ({ child: fd, parent: fd === 0 ? (input?.fd ?? fd) : fd })),
      });
      reserved = true;
      return child;
    } finally {
      releaseInput(descriptors, input, notices, !reserved);
    }
  };
  return {
    async exec(request: TestRequest): Promise<TestExecution> {
      output.stdout.length = 0;
      output.stderr.length = 0;
      const child = spawn(request);
      active.add(child);
      await flush();
      await supervisor.start(child);
      const exit = await supervisor.waitForExit(transport.pid, child);
      const deadline = performance.now() + 5000;
      while (!client.childExited(transport.pid, child)) {
        if (performance.now() > deadline)
          throw new Error(`Child ${child} did not physically retire`);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      client.wait(transport.pid, child);
      await flush();
      active.delete(child);
      return {
        status: exit.kind === "start-failed" ? 127 : (exit.status ?? 128),
        stdout: decode(output.stdout),
        stderr:
          (exit.kind === "start-failed" ? `start-failed ${exit.error}\n` : "") +
          decode(output.stderr),
      };
    },
    async dispose() {
      const stopped = await Promise.allSettled(
        Array.from(active, (child) => service.kill(child, 9)),
      );
      try {
        descriptors.dispose();
      } finally {
        discardOwnedNotices(notices);
      }
      if (descriptors.inheritable().length) throw new Error("Test root retained descriptors");
      const failed = stopped.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
