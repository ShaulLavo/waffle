import { startPage } from "waffle/testing/page-runner/page";
import { runtimeThreadCases } from "../threads-runtime-cases.js";
import { runThreadsRuntime } from "../threads-runtime-browser.js";
import type { ThreadRuntimeRequest } from "./threads-runtime-suite.js";

startPage<ThreadRuntimeRequest>({
  list: async () => ({ ids: runtimeThreadCases.map((selected) => `threads-runtime: ${selected}`) }),
  async run({ selected, fixtureSha256 }) {
    const result = await runThreadsRuntime(selected, false, fixtureSha256);
    return {
      ...result,
      document: { url: location.href, timeOrigin: performance.timeOrigin },
    };
  },
  async finish(ledger) {
    if (ledger.length) throw new Error("Runtime thread cases use no durable storage");
    return [];
  },
});
