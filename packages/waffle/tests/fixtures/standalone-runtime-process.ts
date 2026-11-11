import { PipePublicationRegistry } from "../../proc/pipes.js";
import { workerProcessState, type WorkerProcessTransport } from "../../proc/worker-client.js";

/** Standalone bootstrap tests have no page runtime or broker to publish their registry. */
export function standaloneRuntimeProcess<T extends WorkerProcessTransport | undefined>(
  transport: T,
): T {
  if (!transport) return transport;
  const data = transport.data;
  if (data && typeof data === "object" && "pipeRegistry" in data) return transport;
  const state = workerProcessState(transport);
  const registry = new PipePublicationRegistry({ wake: state.wake });
  registry.registerProcess(state.pid);
  transport.data = {
    ...(data && typeof data === "object" ? data : {}),
    pipeRegistry: registry.handle(),
  };
  return transport;
}
