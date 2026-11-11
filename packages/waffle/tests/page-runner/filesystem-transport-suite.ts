import { resolve } from "node:path";
import type { HostCase, SuiteAdapter } from "waffle/testing/page-runner";
import { record, strings } from "./protocol.js";

export const filesystemTransportId = "filesystem-transport: complete command";
export const filesystemTransportSources = {
  "/original.js": "filesystem-transport-browser.ts",
  "/fs.js": "fixtures/filesystem-port-service.ts",
  "/child.js": "fixtures/filesystem-port-worker.ts",
};
export async function driveFilesystemTransport(host: HostCase, rounds: number) {
  host.signal.throwIfAborted();
  await host.task(`await window.__filesystemTransport.run(${JSON.stringify(rounds)});`);
  return host.script("return window.__filesystemTransport.value;");
}
export function checkFilesystemTransport(rounds: number, value: unknown): void {
  if (
    !record(value) ||
    !record(value.body) ||
    value.body.status !== "pass" ||
    !record(value.body.result) ||
    !record(value.teardown) ||
    value.teardown.status !== "pass" ||
    !record(value.teardown.result) ||
    value.teardown.result.live !== 0 ||
    value.teardown.result.workerRestored !== true
  )
    throw new Error("Missing complete filesystem transport command or cleanup");
  const { result, observation } = value.body.result;
  checkOriginalResult(rounds, result);
  checkWorkerObservation(rounds, observation);
}
function checkOriginalResult(rounds: number, result: unknown): void {
  const children = rounds * 2 + 2;
  if (
    !record(result) ||
    result.ok !== children ||
    result.lost !== 0 ||
    result.messageerrors !== 0 ||
    result.sharedPayloads !== 0 ||
    result.crossOriginIsolated !== true ||
    typeof result.retainedBytes !== "number" ||
    !Number.isSafeInteger(result.retainedBytes) ||
    result.retainedBytes < 0 ||
    result.namespaceRequests !== 0 ||
    !record(result.large) ||
    result.large.matches !== true ||
    result.large.payloads !== 5 ||
    result.large.payloadBytes !== 0 ||
    typeof result.large.arenaBytes !== "number" ||
    result.large.arenaBytes > 1024 * 1024
  )
    throw new Error("Incomplete original filesystem transport result");
}
function checkWorkerObservation(rounds: number, observation: unknown): void {
  const children = rounds * 2 + 2;
  if (
    !record(observation) ||
    observation.created !== children + 1 ||
    observation.ready !== children ||
    observation.completed !== children ||
    observation.disposed !== 1 ||
    observation.live !== 0 ||
    typeof observation.sharedBuffers !== "number" ||
    observation.sharedBuffers <= 0 ||
    typeof observation.sharedBytes !== "number" ||
    observation.sharedBytes <= 0
  )
    throw new Error("Missing real Worker or SharedArrayBuffer observations");
}
export function filesystemTransportAdapter(rounds = 60): SuiteAdapter<{ rounds: number }> {
  if (!Number.isSafeInteger(rounds) || rounds < 0) throw new Error("Invalid transport rounds");
  return {
    suite: "filesystem-transport",
    inventory: () => [
      {
        id: filesystemTransportId,
        label: "complete command",
        request: () => ({ rounds }),
        drive: (host) => driveFilesystemTransport(host, rounds),
      },
    ],
    policy: {
      requireResult: true,
      listIds(value) {
        if (
          !record(value) ||
          !strings(value.ids) ||
          value.ids.length !== 1 ||
          value.ids[0] !== filesystemTransportId
        )
          throw new Error("Wrong complete filesystem transport inventory");
        return value.ids;
      },
      check: (_id, value) => checkFilesystemTransport(rounds, value),
    },
    async assets({ signal }) {
      const sources = {
        ...filesystemTransportSources,
        "/page.js": "page-runner/filesystem-transport-page.ts",
      };
      const assets: Record<string, Blob | string> = {};
      for (const [route, source] of Object.entries(sources)) {
        signal.throwIfAborted();
        const built = await Bun.build({
          entrypoints: [resolve(import.meta.dir, "..", source)],
          target: "browser",
          format: "esm",
          define: { LEGACY_SOURCE: "false" },
        });
        if (!built.success || !built.outputs[0])
          throw new AggregateError(built.logs, `Filesystem transport bundle failed: ${source}`);
        assets[route] = built.outputs[0];
      }
      signal.throwIfAborted();
      return assets;
    },
    // Original per-operation deadlines remain inside the unchanged command and Workers.
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 180_000,
      group: 180_000,
      run: 180_000,
    }),
  };
}
