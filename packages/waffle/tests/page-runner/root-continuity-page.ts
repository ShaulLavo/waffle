import {
  rootContinuityControls,
  rootContinuityJSON,
  type RootContinuityRequest,
} from "../root-continuity-command.js";
import { startPage } from "./page-main.js";
import { cleanupStorage } from "./storage-cleanup.js";
import { rootContinuityStorage } from "./root-continuity-allocation.js";

async function composition(): Promise<typeof import("../root-continuity-browser.js")> {
  const path = "/composition.js";
  const suite: typeof import("../root-continuity-browser.js") = await import(path);
  if (
    typeof suite.selectedRootComposition !== "function" ||
    typeof suite.startupFenceComposition !== "function"
  )
    throw new Error("Missing root continuity composition export");
  return suite;
}

startPage<RootContinuityRequest>({
  async list() {
    await composition();
    return { ids: rootContinuityControls.map((control) => `root-continuity: ${control}`) };
  },
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
    const storage = rootContinuityStorage(request, allocate, current);
    const suite = await composition();
    const evidence =
      request.control === "selected"
        ? await suite.selectedRootComposition(storage)
        : await suite.startupFenceComposition(request.control, storage);
    const returned: unknown = JSON.parse(rootContinuityJSON(evidence));
    return returned;
  },
  finish: cleanupStorage,
});
