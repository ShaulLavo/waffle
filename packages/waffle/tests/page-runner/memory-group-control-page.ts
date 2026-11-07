import { memoryGroupBrowser as original } from "../memory-group-browser.js";

/** @browserEntry Runs every original phase before returning a deliberately wrong disposal. */
export async function memoryGroupBrowser() {
  const report = await original();
  return { ...report, disposal: "resolved | guard: released" };
}
