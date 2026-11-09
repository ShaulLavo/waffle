import { objectDefineProperty } from "../proc/intrinsics.js";

/** Ordinals count attempts in this module instance, not live roots or native memory. */
export interface FilesystemIdentityAllocation {
  identityOrdinal: number;
  rootOrdinal: number | null;
  kind: "independent" | "inherited" | "provided";
  stage: "root" | "segments" | "identity";
  rootComplete: boolean;
  segmentSlot: number | null;
  segmentsCompleted: number;
  segmentsPlanned: number;
}
let identities = 0;
let roots = 0;
export function beginIdentityAllocation(
  inherited: boolean,
  provided: boolean,
  segmentsPlanned: number,
): FilesystemIdentityAllocation {
  return {
    identityOrdinal: ++identities,
    rootOrdinal: inherited || provided ? null : ++roots,
    kind: inherited ? "inherited" : provided ? "provided" : "independent",
    stage: "root",
    rootComplete: false,
    segmentSlot: null,
    segmentsCompleted: 0,
    segmentsPlanned: inherited ? 0 : segmentsPlanned,
  };
}
export function recordIdentityAllocationFailure(
  error: unknown,
  allocation: FilesystemIdentityAllocation,
): void {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    objectDefineProperty(error, "filesystemAllocation", {
      __proto__: null,
      value: { ...allocation },
      configurable: true,
    });
  } catch {
    // A frozen or otherwise unannotatable thrown value must still escape unchanged.
  }
}
