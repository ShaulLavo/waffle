import type { Runtime, RuntimeSupervisor } from "../../index.js";
import { DescriptorTable, type Stream } from "../../core/descriptors.js";
import { createRuntimeTerminalCodec } from "../../browser/runtime-terminals.js";
import { createWorkerPipeCodec } from "../../proc/worker-pipes.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../../proc/worker-client.js";

export async function createProgramShell(runtime: Runtime, tables: DescriptorTable[]) {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const output: string[] = [];
  await service.adoptRuntimeRoot(transport, {
    output: (_fd, bytes) => output.push(new TextDecoder().decode(bytes)),
  });
  const notices: WorkerProcessMessage[] = [];
  // The root's own terminal at fd 1 and 2. Children get stdio only through explicit bindings;
  // the terminal codec transfers it, and child writes come back through the root's output.
  const descriptors = new DescriptorTable();
  tables.push(descriptors);
  const write = (chunks: readonly Uint8Array[]) => {
    for (const chunk of chunks) output.push(new TextDecoder().decode(chunk));
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
  };
  const terminal: Stream = {
    kind: "terminal",
    read: () => 0,
    write,
    tryWrite: write,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
  };
  descriptors.openAt(1, terminal, 64n, 0n);
  descriptors.inherit(2, descriptors.get(1)!);
  const codec = createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() });
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec,
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    postMessage: (message) => notices.push(message),
  });
  const supervisor: RuntimeSupervisor = await service.ready();
  const pid = transport.pid;
  return {
    output,
    /** The guest-facing access query a shell uses for `command -v`: metadata only. */
    async access(path: string): Promise<number> {
      const id = supervisor.accessStart(pid, path, "/");
      while (!supervisor.accessReady(pid, id)) await Bun.sleep(1);
      return supervisor.accessTake(pid, id);
    },
    async spawn(
      executable: string,
      argv: string[],
      env: Record<string, string> = {},
      fds = [
        { parent: 1, child: 1 },
        { parent: 2, child: 2 },
      ],
    ) {
      const child = client.spawn(pid, { executable, argv, env, cwd: "/", job: -1, fds });
      while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
      await supervisor.start(child);
      return {
        pid: child,
        kill: () => service.kill(child, 9),
        exit: supervisor.waitForExit(pid, child).then(async (exit) => {
          client.wait(pid, child);
          while (notices.length) await service.runtimeMessage(notices.shift()!, pid);
          return exit;
        }),
      };
    },
    async exec(executable: string, argv: string[], env?: Record<string, string>) {
      return (await this.spawn(executable, argv, env)).exit;
    },
  };
}
