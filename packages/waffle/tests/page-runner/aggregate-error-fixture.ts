import { withStorageCleanup } from "../storage-allocation.js";
/** @browserEntry */
export function storageTests() {
  return [
    {
      label: "aggregate-error",
      run: () =>
        withStorageCleanup(
          () => Promise.reject(new Error("PRIMARY_ASSERTION")),
          () => Promise.reject(new Error("CLEANUP_FAILURE")),
        ),
    },
  ];
}
/** @browserEntry */
export function opfsStorageTests() {
  return [];
}
