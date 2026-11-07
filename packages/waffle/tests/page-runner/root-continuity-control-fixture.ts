declare const ROOT_CONTINUITY_FAILURE: "throwing-body" | "wrong-evidence";

/** @browserEntry */
export function selectedRootComposition(): Promise<unknown> {
  if (ROOT_CONTINUITY_FAILURE === "throwing-body") throw new Error("ROOT_CONTINUITY_BODY_FAILURE");
  return Promise.resolve({ wrong: "actual returned evidence" });
}
/** @browserEntry */
export function startupFenceComposition(): Promise<unknown> {
  return selectedRootComposition();
}
