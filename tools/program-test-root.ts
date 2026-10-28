import type { Runtime } from "waffle";
import type { SpawnRequest } from "waffle/proc/types";
import { DescriptorTable } from "waffle/core/descriptors";
import { createRuntimeTerminalCodec } from "waffle/browser/runtime-terminals";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "waffle/proc/worker-client";

export type TestExecution = { status: number; stdout: string; stderr: string };
export type TestRequest = Pick<SpawnRequest, "executable" | "argv" | "env" | "cwd"> & {
  readonly input?: string;
};

function decode(chunks: readonly Uint8Array[]) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function inputPipe(pipes: WorkerPipeHost, descriptors: DescriptorTable, input: string): number {
  const [reader, writer] = pipes.createPipe();
  const bytes = new TextEncoder().encode(input);
  try {
    if (writer.write([bytes]) !== bytes.length) throw new Error("Short test stdin write");
    return descriptors.open(reader, (1n << 1n) | (1n << 21n) | (1n << 27n), 0n);
  } catch (error) {
    reader.close();
    throw error;
  } finally {
    writer.close();
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
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
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
  const notices: WorkerProcessMessage[] = [];
  const pipes = new WorkerPipeHost({ transport, postMessage: (message) => notices.push(message) });
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: createRuntimeTerminalCodec({ descriptors, fallback: pipes.codec() }),
    prepareSpawn: (child) => {
      pipes.registry.registerProcess(child);
      return {
        data: {
          filesystem: runtime.filesystem.createIdentity(),
          pipeRegistry: pipes.registry.handle(),
        },
      };
    },
    postMessage: (message) => notices.push(message),
  });
  const active = new Set<number>();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, transport.pid);
  };
  const spawn = (request: TestRequest) => {
    const inputFd =
      request.input === undefined ? undefined : inputPipe(pipes, descriptors, request.input);
    try {
      return client.spawn(transport.pid, {
        executable: request.executable,
        argv: request.argv,
        env: request.env,
        cwd: request.cwd,
        job: -1,
        fds: [0, 1, 2].map((fd) => ({ child: fd, parent: fd === 0 ? (inputFd ?? fd) : fd })),
      });
    } finally {
      if (inputFd !== undefined) descriptors.close(inputFd);
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
      try {
        for (const child of active) await service.kill(child, 9);
      } finally {
        descriptors.dispose();
        if (descriptors.inheritable().length) throw new Error("Test root retained descriptors");
      }
    },
  };
}
