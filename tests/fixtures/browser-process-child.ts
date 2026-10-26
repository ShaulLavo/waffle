import type { BrowserProcessBroker } from "../../browser/process-broker.js";
import type { WorkerProcessClient, WorkerProcessMessage } from "../../proc/worker-client.js";

export async function startFixtureChild({
  broker,
  parent,
  messages,
}: {
  broker: BrowserProcessBroker;
  parent: WorkerProcessClient;
  messages: readonly WorkerProcessMessage[];
}) {
  const pid = parent.spawn(parent.pid, {
    executable: "fixture",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  for (const message of messages) await broker.runtimeMessage(message, parent.pid);
  const supervisor = await broker.ready();
  await supervisor.start(pid);
  return { pid, supervisor };
}
