import { startPage } from "waffle/testing/page-runner/page";
import type { ProcessRecyclingRequest } from "./process-recycling-suite.js";
import { forbidDurableProcessStorage } from "./process-recycling-storage-control.js";

declare const PROCESS_CONTROL: "memory-only" | "page-error" | "wrong-label";
forbidDurableProcessStorage();
async function fixture() {
  const path = "/tests.js";
  return (await import(path)) as typeof import("../process-recycling-browser.js");
}
startPage<ProcessRecyclingRequest>({
  list: async () => (await fixture()).processBrowserCases(),
  async run({ label }) {
    if (PROCESS_CONTROL === "page-error") {
      setTimeout(() => {
        throw new Error("PROCESS_CONTROL_PAGE_ERROR");
      }, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await (await fixture()).runProcessBrowserCase(label);
    return PROCESS_CONTROL === "wrong-label" ? "PROCESS_CONTROL_WRONG_LABEL" : result;
  },
  async finish(ledger) {
    if (ledger.length) throw new Error("Process control received durable allocations");
    return [];
  },
});
