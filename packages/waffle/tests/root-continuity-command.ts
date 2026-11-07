import type { StorageAllocationHooks } from "./storage-allocation.js";

export const rootContinuityControls = ["selected", "cancel", "failure"] as const;
export type RootContinuityControl = (typeof rootContinuityControls)[number];
export type RootContinuityStorage = StorageAllocationHooks;
export type RootContinuityRequest = { run: string; control: RootContinuityControl };

export const rootContinuityOpenPaths: readonly {
  control: RootContinuityControl;
  target: number;
}[] = [
  { control: "selected", target: 1 },
  { control: "selected", target: 2 },
  { control: "selected", target: 3 },
  { control: "cancel", target: 1 },
  { control: "failure", target: 1 },
];

export function rootContinuityJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}
