import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/xargs`, its own WASM program, on the caller's Runtime. */
export function installXargs(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/xargs.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "xargs", path: "/bin/xargs", defaultUrl, execution: "wasi" },
    options,
  );
}
