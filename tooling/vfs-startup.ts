import type { RuntimeStartupStage } from "../fs/startup.js";

/** Production worker-realm timestamps share one monotonic epoch; do not mix
 * requested→resolved IndexedDB open with later ownership/tree recovery time. */
export function indexeddbStartupIntervals(
  stages: Readonly<Partial<Record<RuntimeStartupStage, number>>>,
): { indexeddbOpenMs: number; treeReadyAfterIndexeddbMs: number } {
  const requested = stages["indexeddb-open-requested"],
    resolved = stages["indexeddb-open-resolved"],
    ready = stages["filesystem-ready"];
  if (
    requested === undefined ||
    resolved === undefined ||
    ready === undefined ||
    ![requested, resolved, ready].every(Number.isFinite)
  )
    throw new Error("Missing IndexedDB startup milestones");
  if (resolved < requested || ready < resolved)
    throw new Error("Non-monotonic IndexedDB startup milestones");
  return { indexeddbOpenMs: resolved - requested, treeReadyAfterIndexeddbMs: ready - resolved };
}
