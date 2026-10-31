import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register upstream traversal and predicate `find` on the caller's Runtime. */
export function installFind(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/find.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "find", path: "/bin/find", defaultUrl, execution: "wasi" },
    options,
  );
}
