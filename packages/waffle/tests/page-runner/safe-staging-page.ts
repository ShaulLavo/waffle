import { safeStagingLabels, safeStagingNative } from "../safe-staging-browser.js";
import { startPage } from "./page-main.js";
import { stagingDatabaseName } from "./safe-staging-allocation.js";
import { cleanupStorage } from "./storage-cleanup.js";
import type { SafeStagingRequest } from "./safe-staging-suite.js";

startPage<SafeStagingRequest>({
  list: () => Promise.resolve({ labels: safeStagingLabels() }),
  async run(request, allocate) {
    const configuration = window.__suiteConfiguration;
    const observation = window.__pageRunner;
    const url = location.href;
    const current = () =>
      configuration.role === "case" &&
      configuration.run === request.run &&
      window.__suiteConfiguration === configuration &&
      window.__pageRunner === observation &&
      location.href === url &&
      !observation.retired &&
      !observation.failure;
    return await safeStagingNative(
      request.selected,
      stagingDatabaseName(request.run, allocate, current),
    );
  },
  finish: cleanupStorage,
});
