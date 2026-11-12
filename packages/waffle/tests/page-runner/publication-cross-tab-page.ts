import { startPage } from "./page-main.js";
import { installPublicationBootstrap } from "./publication-bootstrap.js";
import { crossTabEvaluator } from "./cross-tab-evaluator.js";
import { crossTabId } from "../publication-cross-tab-inventory.js";

installPublicationBootstrap();
window.__crossTabEvaluator = crossTabEvaluator();
startPage<null>({
  list: async () => ({ ids: [crossTabId] }),
  run: {
    kind: "host",
    peer: async () => {},
    teardown: async () => ({ settled: true }),
  },
  async finish(ledger) {
    if (ledger.length) throw new Error("Original cross-tab command owns database cleanup");
    return [];
  },
});
