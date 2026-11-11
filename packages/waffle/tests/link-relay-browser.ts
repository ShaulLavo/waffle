import { createRuntime } from "../runtime.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { prepareLinkPlan } from "../link/index.js";
import type { LinkedWorkerRequest } from "../link/worker.js";
import { relayProgram } from "./fixtures/link-relay-program.js";
import { DescriptorTable } from "../core/descriptors.js";
import { captureNativeReturn } from "../proc/observation.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";

export async function linkedRelayBrowser() {
  const plan = await prepareLinkPlan(relayProgram());
  const diagnostics: unknown[] = [];
  const runtime = createRuntime({
    filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
    processHost: (options) =>
      new BrowserProcessBroker({ ...options, onError: (error) => diagnostics.push(error) }),
  });
  let observation: object | undefined;
  const descriptors = new DescriptorTable();
  const root = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  const returned = captureNativeReturn(root);
  const notices: WorkerProcessMessage[] = [];
  const identity = runtime.filesystem.createIdentity();
  root.data = { filesystem: identity };
  const unused = (): never => {
    throw new Error("relay fixture has no inherited descriptors");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage: (message) => notices.push(message),
    prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
  });
  function output(message: unknown) {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "error") diagnostics.push(JSON.stringify(message));
    if (message.type === "relay-observation") observation = message;
  }
  try {
    runtime.registerAdapter("relay", (context, service) =>
      service.launchWorker<LinkedWorkerRequest>(context, {
        workerUrl: "/relay-worker.js",
        request: {
          module: context.module,
          linkPlan: plan.shared,
          args: context.request.argv,
          env: context.request.env,
        },
        onMessage: output,
      }),
    );
    runtime.registerProgram("/relay", {
      adapter: "relay",
      module: plan.entryModule,
      cooperative: true,
    });
    await runtime.filesystem.writeFile("/relay", new Uint8Array());
    const service = await runtime.processes();
    await service.adoptRuntimeRoot(root, { memory: [], filesystem: identity });
    const supervisor = await service.ready();
    const pid = client.spawn(root.pid, {
      executable: "/relay",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    for (const message of notices.splice(0)) await service.runtimeMessage(message, root.pid);
    await supervisor.start(pid);
    const exit = await supervisor.waitForExit(root.pid, pid);
    if (exit.kind !== "exited" || exit.code !== 8)
      throw new Error(
        `relay process failed: ${JSON.stringify(exit)}; ${diagnostics.map(String).join("; ")}`,
      );
    if (client.wait(root.pid, pid)?.code !== 8) throw new Error("relay process was not collected");
    if (diagnostics.length) throw new AggregateError(diagnostics, "relay process diagnostics");
    if (!observation) throw new Error("worker compiler observation was not delivered");
    return observation;
  } finally {
    descriptors.dispose();
    returned();
    await runtime.dispose();
  }
}
