import { resolve } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { crossTabAssets } from "../publication-cross-tab-assets.js";
import { crossTabCommand } from "../publication-cross-tab-command.js";
import {
  checkCrossTabLabels,
  crossTabId,
  crossTabTimeoutMs,
} from "../publication-cross-tab-inventory.js";
import { nativeCrossTabLifecycle, type CrossTabWorkerEvent } from "./publication-cross-tab-host.js";
import { diagnosticsFor } from "./stall-diagnostics.js";
import { record, type HostCase } from "./protocol.js";
import type { SuiteAdapter } from "./consumer.js";

async function drive(host: HostCase): Promise<unknown> {
  const labels: string[] = [];
  const events: CrossTabWorkerEvent[] = [];
  const command = crossTabCommand(nativeCrossTabLifecycle(host, events), (...values) => {
    console.log(...values);
    if (typeof values[0] === "string" && values[0].startsWith("PASS ")) {
      labels.push(values[0].slice(5));
      const trace = diagnosticsFor(host)?.diagnostics.labels;
      if (trace) trace.end(trace.begin("label", { label: labels.length }), "completed");
    }
  });
  const origin = await host.script("return location.origin;");
  if (typeof origin !== "string") throw new Error("Missing cross-tab origin");
  await command.run("ios-safari", origin, false);
  checkCrossTabLabels(labels);
  return { labels, events };
}

export const crossTabAdapter: SuiteAdapter<null> = {
  suite: "publication-cross-tab",
  inventory: () => [
    {
      id: crossTabId,
      label: "complete original cross-tab command",
      request: () => null,
      observation: "workers-and-requests",
      drive,
    },
  ],
  policy: {
    requireResult: true,
    listIds(value) {
      if (
        !record(value) ||
        !Array.isArray(value.ids) ||
        value.ids.length !== 1 ||
        value.ids[0] !== crossTabId
      )
        throw new Error("Wrong complete cross-tab inventory");
      return [crossTabId];
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
        throw new Error("Missing cross-tab body or settled teardown");
      checkCrossTabLabels(value.body.result.labels);
    },
  },
  async assets({ signal }) {
    signal.throwIfAborted();
    const assets = await crossTabAssets();
    assets["/page.js"] = await browserBundle(
      resolve(import.meta.dir, "publication-cross-tab-page.ts"),
    );
    signal.throwIfAborted();
    return assets;
  },
  budgets: () => ({
    hello: 20_000,
    heartbeat: 10_000,
    case: crossTabTimeoutMs,
    group: crossTabTimeoutMs,
    run: crossTabTimeoutMs,
  }),
};
