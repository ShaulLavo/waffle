import { resolve } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import {
  checkPublicationLabels,
  publicationId,
  type PublicationMode,
} from "../publication-command.js";
import { record, strings, type HostCase, type HostWorker } from "./protocol.js";
import type { SuiteAdapter } from "./suite-host.js";

async function drivePublication(host: HostCase, mode: PublicationMode): Promise<unknown> {
  const workers: HostWorker[] = [];
  const events: { kind: string; worker: number; url: string }[] = [];
  const remove = host.onWorker((event) => {
    if (event.kind === "created") workers.push(event.worker);
    const worker = workers.indexOf(event.worker);
    if (worker < 0) throw new Error("Worker close preceded its creation");
    events.push({ kind: event.kind, worker, url: event.worker.url });
  });
  try {
    await host.task(`await window.__publicationCommand.run(${JSON.stringify(mode)});`);
    const labels = await host.script("return window.__publicationCommand.result();");
    checkPublicationLabels(mode, labels);
    return { labels, events };
  } finally {
    await remove();
  }
}
export function publicationAdapter(mode: PublicationMode): SuiteAdapter<{ mode: PublicationMode }> {
  const id = publicationId(mode);
  return {
    suite: `publication-${mode}`,
    inventory: () => [
      {
        id,
        label: `complete ${mode} command`,
        request: () => ({ mode }),
        query: () => ({ mode }),
        observation: "workers-and-requests",
        drive: (host) => drivePublication(host, mode),
      },
    ],
    policy: {
      requireResult: true,
      listIds(value) {
        if (!record(value) || !strings(value.ids) || value.ids.length !== 1 || value.ids[0] !== id)
          throw new Error("Wrong complete publication inventory");
        return value.ids;
      },
      check(_id, value) {
        if (
          !record(value) ||
          !record(value.body) ||
          value.body.status !== "pass" ||
          !record(value.body.result) ||
          !record(value.teardown) ||
          value.teardown.status !== "pass" ||
          !record(value.teardown.result) ||
          value.teardown.result.settled !== true
        )
          throw new Error("Missing complete publication result or teardown");
        checkPublicationLabels(mode, value.body.result.labels);
      },
    },
    async assets({ signal }) {
      const sources = {
        "/page.js": "page-runner/publication-page.ts",
        "/tests.js": mode === "workspace" ? "workspace-browser.ts" : "publication-browser.ts",
        "/fs-worker.js": "../browser/fs-worker.ts",
        "/read-worker.js": "workspace-vfs-read-browser.ts",
        "/guest.js": "fixtures/publication-guest.ts",
      };
      const assets: Record<string, Blob | string> = {};
      for (const [route, source] of Object.entries(sources)) {
        signal.throwIfAborted();
        if (route !== "/page.js") {
          assets[route] = await browserBundle(resolve(import.meta.dir, "..", source));
          continue;
        }
        const built = await Bun.build({
          entrypoints: [resolve(import.meta.dir, "..", source)],
          target: "browser",
          define: { PUBLICATION_MODE: JSON.stringify(mode) },
        });
        if (!built.success || !built.outputs[0])
          throw new AggregateError(built.logs, "Publication page bundle failed");
        assets[route] = built.outputs[0];
      }
      return assets;
    },
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 180_000,
      group: 180_000,
      run: 180_000,
    }),
  };
}
