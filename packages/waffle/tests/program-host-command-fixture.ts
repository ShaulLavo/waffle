import type { Runtime } from "../runtime.js";
import type { RuntimeRootOptions } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { FilesystemClient } from "../fs/client.js";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";

export async function commandShell(
  runtime: Runtime,
  cleanup: Array<() => void | Promise<void>>,
  options: RuntimeRootOptions = {},
) {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  const identity = runtime.filesystem.createIdentity();
  transport.data = { filesystem: identity };
  await service.adoptRuntimeRoot(transport, options);
  const filesystem = new FilesystemClient(runtime.filesystem.connect(identity));
  cleanup.push(() => filesystem.dispose());
  const descriptors = new DescriptorTable();
  cleanup.push(() => descriptors.dispose());
  const notices: WorkerProcessMessage[] = [];
  const codec = createRuntimeTerminalCodec({ descriptors, fallback: createWorkerPipeCodec() });
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec,
    prepareSpawn: () => {
      const filesystemIdentity = runtime.filesystem.createIdentity();
      return {
        data: { filesystem: filesystemIdentity },
        codec: createRuntimeTerminalCodec({
          descriptors,
          fallback: createWorkerPipeCodec({
            fallback: createFilesystemDescriptorCodec(filesystem, filesystemIdentity),
          }),
        }),
      };
    },
    postMessage: (message) => notices.push(message),
  });
  const supervisor = await service.ready();
  const flush = async () => {
    while (notices.length) await service.runtimeMessage(notices.shift()!, transport.pid);
  };
  return {
    service,
    supervisor,
    root: transport.pid,
    descriptors,
    filesystem,
    client,
    transport,
    async spawn(
      executable: string,
      argv = [executable],
      fds: { parent: number; child: number }[] = [],
    ) {
      const pid = client.spawn(transport.pid, {
        executable,
        argv,
        env: {},
        cwd: "/",
        job: -1,
        fds,
      });
      await flush();
      const exit = supervisor.waitForExit(transport.pid, pid);
      await supervisor.start(pid);
      return {
        pid,
        exit,
        collect: async () => {
          const result = await supervisor.waitForExit(transport.pid, pid);
          client.wait(transport.pid, pid);
          await flush();
          return result;
        },
      };
    },
    async file(fd: number, path: string, append = false) {
      await runtime.filesystem.writeFile(path, new Uint8Array());
      const root: number = await filesystem.asyncCall("preopen", ["/"]);
      const resolved: { node?: number } | number = await filesystem.asyncCall("resolve", [
        root,
        path.slice(1),
        true,
      ]);
      if (typeof resolved === "number" || resolved.node === undefined)
        throw new Error("missing file");
      const handle = resolved.node;
      filesystem.retain(handle);
      descriptors.openAt(fd, { kind: "file", handle, offset: 0, append }, 2n | 64n, 0n, () =>
        filesystem.release(handle),
      );
    },
  };
}
