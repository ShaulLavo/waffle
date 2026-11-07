import { processBrowserCases } from "../process-recycling-browser.js";
import { processRecyclingAssets } from "./process-recycling-assets.js";
import { strings } from "./protocol.js";
import type { SuiteAdapter } from "waffle/testing/page-runner";

export type ProcessRecyclingRequest = { label: string };
export const processRecyclingAdapter: SuiteAdapter<ProcessRecyclingRequest> = {
  suite: "process-recycling",
  inventory: () =>
    processBrowserCases().map((label) => ({ id: label, label, request: () => ({ label }) })),
  policy: {
    requireResult: true,
    listIds(value) {
      const labels = processBrowserCases();
      if (
        !strings(value) ||
        value.length !== labels.length ||
        value.some((label, index) => label !== labels[index])
      )
        throw new Error("Wrong complete process recycling inventory or order");
      return value;
    },
    check(label, result) {
      if (result !== label)
        throw new Error(`Wrong original process completion label: ${JSON.stringify(result)}`);
    },
  },
  page: { path: "/process", script: "/process-page.js" },
  assets: processRecyclingAssets,
  // Body waits remain inside their original fixtures. This is one absolute command clock.
  budgets: () => ({
    hello: 30_000,
    heartbeat: 10_000,
    case: 600_000,
    group: 600_000,
    run: 600_000,
  }),
};
