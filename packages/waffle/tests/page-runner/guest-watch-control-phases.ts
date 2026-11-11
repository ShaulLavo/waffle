import { guestWatchCase as watch } from "../guest-watch-browser-cases.js";
import { notificationRelayRaceCase as relay } from "../notification-race-cases.js";

const originalDocument = document;
let watchFinished = false;

/** @browserEntry Checks composition while running the unchanged guest-watch body. */
export async function guestWatchCase(workerUrl: string, helperUrl: string, writerUrl: string) {
  if (watchFinished) throw new Error("Guest watch ran twice in the same document");
  const result = await watch(workerUrl, helperUrl, writerUrl);
  watchFinished = true;
  return result;
}

/** @browserEntry Requires the completed first phase in this exact module and document. */
export async function notificationRelayRaceCase(helperUrl: string) {
  if (!watchFinished || document !== originalDocument)
    throw new Error("Relay did not follow guest watch in the same document");
  return await relay(helperUrl);
}
