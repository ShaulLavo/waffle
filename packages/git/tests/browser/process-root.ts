import type { Runtime } from "waffle";
import { DescriptorTable } from "waffle/core/descriptors";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "waffle/proc/worker-client";

export type Result = { status: number; stdout: string; stderr: string };

/** A page root that spawns programs through Waffle admission, as in Waffle's WASI guide. */
export async function processRoot(runtime: Runtime, env: Readonly<Record<string, string>>) {
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const descriptors = new DescriptorTable();
  const rootJob = runtime.identities.job();
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: rootJob,
    identity: runtime.identities.buffer,
    capacity: 4,
  });
  root.data = { filesystem: runtime.filesystem.createIdentity() };
  const unused = (): never => {
    throw new Error("no descriptors are transferred");
  };
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  const outputs = { 1: "", 2: "" };
  const decoder = new TextDecoder();
  await service.adoptRuntimeRoot(root, {
    output: (fd, bytes) => {
      if (fd === 1 || fd === 2) outputs[fd] += decoder.decode(bytes);
    },
  });
  const spawn = async (argv: readonly string[], cwd: string, executable = "/usr/bin/git"): Promise<Result> => {
    outputs[1] = "";
    outputs[2] = "";
    const pid = client.spawn(root.pid, {
      executable,
      argv: [executable.slice(executable.lastIndexOf("/") + 1)].concat(argv),
      env: { ...env, PATH: "/usr/bin:/bin", HOME: "/home/user" },
      cwd,
      job: rootJob,
      fds: [],
    });
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
    await supervisor.start(pid);
    const exit = await supervisor.waitForExit(root.pid, pid);
    // Reap through the root's own client so its child directory slot is released.
    while (!client.childExited(root.pid, pid)) await new Promise((resolve) => setTimeout(resolve, 1));
    client.wait(root.pid, pid);
    while (notices.length) await service.runtimeMessage(notices.shift()!, root.pid);
    const status = exit.kind === "start-failed" ? 127 : exit.status ?? 128;
    const stderr = exit.kind === "start-failed" ? `${outputs[2]}start-failed ${exit.error}` : outputs[2];
    return { status, stdout: outputs[1], stderr };
  };
  return { spawn, dispose: () => descriptors.dispose() };
}
