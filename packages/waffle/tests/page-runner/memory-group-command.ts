import { join, resolve } from "node:path";
import { buildFixture, verifiedFixture } from "../../scripts/build-memory-group-fixture.js";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { commandPageBundle, type CommandRequest } from "./command-suites.js";
import { record, strings } from "./protocol.js";
import type { SuiteAdapter } from "./suite-host.js";

export function checkMemoryGroupResult(report: unknown): void {
  if (
    !record(report) ||
    typeof report.disposal !== "string" ||
    !report.disposal.includes("memory group members") ||
    !report.disposal.includes("A live page runtime already owns this page")
  )
    throw new Error(
      `disposal released the page with unsettled group debt: ${record(report) ? report.disposal : report}`,
    );
}

const request: CommandRequest = {
  entry: "/memory-group-browser.js",
  exportName: "memoryGroupBrowser",
  args: [],
};
const id = "memory-group: memoryGroupBrowser";
const sources = {
  "/memory-group-browser.js": "memory-group-browser.ts",
  "/memory-group-worker.js": "fixtures/memory-group-worker.ts",
  "/fs-worker.js": "../browser/fs-worker.ts",
};

export const memoryGroupAdapter: SuiteAdapter<CommandRequest> = {
  suite: "memory-group",
  inventory: () => [{ id, label: request.exportName, request: () => request }],
  policy: {
    requireResult: true,
    listIds(value) {
      if (!record(value) || Object.keys(value).length !== 1 || !strings(value.ids))
        throw new Error("Invalid memory group command inventory");
      return value.ids;
    },
    check: (_id, result) => checkMemoryGroupResult(result),
  },
  async assets({ scratch, signal }) {
    signal.throwIfAborted();
    let directory = process.env.MEMORY_GROUP_FIXTURE_DIR;
    if (!directory) {
      directory = join(scratch, "fixture");
      buildFixture(directory);
    }
    signal.throwIfAborted();
    const assets: Record<string, Blob | string> = {
      "/page.js": await commandPageBundle({ ...request, id }),
      "/memory-group-member.wasm": new Blob([verifiedFixture(directory)], {
        type: "application/wasm",
      }),
    };
    for (const [path, source] of Object.entries(sources)) {
      signal.throwIfAborted();
      assets[path] = await browserBundle(resolve(import.meta.dir, "..", source));
    }
    return assets;
  },
  // The normal browser matrix bounds the entire original command at 600 seconds.
  budgets: () => ({
    hello: 20_000,
    heartbeat: 10_000,
    case: 600_000,
    group: 600_000,
    run: 600_000,
  }),
};
