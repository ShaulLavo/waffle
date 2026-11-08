import { startPage, cleanupStorage } from "waffle/testing/page-runner/page";
import { networkRelayBrowserCases } from "./network-relay-browser.js";
import { relayId } from "./network-page-contract.js";

startPage<null>({
  list: async () => ({ ids: [relayId] }),
  run: async (_request, _allocate, context) =>
    networkRelayBrowserCases({ fetchFixture: context.fetchFixture }),
  finish: cleanupStorage,
});
