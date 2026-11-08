import { startPage, cleanupStorage } from "waffle/testing/page-runner/page";
import { networkBrowserCases } from "./network-browser.js";
import { networkId } from "./network-page-contract.js";

startPage<null>({
  list: async () => ({ ids: [networkId] }),
  async run(_request, _allocate, context) {
    if (!context.serviceWorker) throw new Error("Missing declared network worker binding");
    return networkBrowserCases({ serviceWorker: context.serviceWorker });
  },
  finish: cleanupStorage,
});
