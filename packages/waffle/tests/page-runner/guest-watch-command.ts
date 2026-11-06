/** @browserEntry Composes the original WebKit phases in one command document. */
export async function guestWatchCase(workerUrl: string, helperUrl: string, writerUrl: string) {
  const watchPath = "/cases.js";
  const watch: typeof import("../guest-watch-browser-cases.js") = await import(watchPath);
  const result = await watch.guestWatchCase(workerUrl, helperUrl, writerUrl);
  if (result.early + result.late !== 200) throw new Error("guest watch proof did not finish");
  const racePath = "/race.js";
  const race: typeof import("../notification-race-cases.js") = await import(racePath);
  const relay = await race.notificationRelayRaceCase(helperUrl);
  return { ...result, relay };
}
