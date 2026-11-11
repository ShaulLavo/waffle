import { startPage } from "waffle/testing/page-runner/page";
import type { ProcessRecyclingRequest } from "./process-recycling-suite.js";

async function fixture() {
  const path = "/tests.js";
  return (await import(path)) as typeof import("../process-recycling-browser.js");
}

startPage<ProcessRecyclingRequest>({
  list: async () => (await fixture()).processBrowserCases(),
  async run({ label }) {
    try {
      return await (await fixture()).runProcessBrowserCase(label);
    } catch (error) {
      // Preserve the actual fixture stack in the automatic result, not a claimed native trace.
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      throw new Error(`Process case ${label}\n${detail}`);
    }
  },
  async finish(ledger) {
    if (ledger.length) throw new Error("Memory-only process command received durable allocations");
    return [];
  },
});
