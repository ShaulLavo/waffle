import { startPage, cleanupStorage } from "waffle/testing/page-runner/page";
import { bufferNetworkActivation } from "./network-activation-browser.js";
import { networkBrowserCases } from "./network-browser.js";
import { networkId } from "./network-page-contract.js";

startPage<null>({
  list: async () => ({ ids: [networkId] }),
  async run(_request, _allocate, context) {
    if (!context.serviceWorker) throw new Error("Missing declared network worker binding");
    const activation = await bufferNetworkActivation();
    return [activation].concat(await networkBrowserCases({ serviceWorker: context.serviceWorker }));
  },
  finish: cleanupStorage,
});
