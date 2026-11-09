import { objectDefineProperty } from "../proc/intrinsics.js";

/** Ordinals count attempts in this module instance, not live roots or native memory. An identity
 * constructs no data segment, so construction has only a root stage and an identity stage. */
export interface FilesystemIdentityAllocation {
  identityOrdinal: number;
  rootOrdinal: number | null;
  kind: "independent" | "inherited" | "provided";
  stage: "root" | "identity";
  rootComplete: boolean;
}
let identities = 0;
let roots = 0;
export function beginIdentityAllocation(
  inherited: boolean,
  provided: boolean,
): FilesystemIdentityAllocation {
  return {
    identityOrdinal: ++identities,
    rootOrdinal: inherited || provided ? null : ++roots,
    kind: inherited ? "inherited" : provided ? "provided" : "independent",
    stage: "root",
    rootComplete: false,
  };
}
export function recordIdentityAllocationFailure(
  error: unknown,
  allocation: FilesystemIdentityAllocation,
): void {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    const descriptor = {
      __proto__: null,
      value: { ...allocation },
      configurable: true,
    };
    objectDefineProperty(error, "filesystemAllocation", descriptor);
  } catch {
    // A frozen or otherwise unannotatable thrown value must still escape unchanged.
  }
}
