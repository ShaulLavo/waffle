import type { createRuntime } from "../../runtime.js";
import { DescriptorTable } from "../../core/descriptors.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../../proc/worker-client.js";

/**
 * A page-side runtime root that spawns and waits for children without descriptors. Its
 * notices queue until `flush` hands them to the runtime's process service.
 */
export function pageRootClient(runtime: ReturnType<typeof createRuntime>) {
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  root.data = { filesystem: runtime.filesystem.createIdentity() };
  const descriptors = new DescriptorTable();
  const notices: WorkerProcessMessage[] = [];
  const unused = (): never => {
    throw new Error("unexpected descriptor transfer");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  return { root, client, descriptors, notices };
}
