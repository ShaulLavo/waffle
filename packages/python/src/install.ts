import type { GuestLauncher, Runtime } from "@waffle-os/runtime";
import { installPrograms } from "@waffle-os/runtime/programs";
import { createPythonPackage, type PythonOptions } from "./index.ts";

/** Install CPython with its required cwd environment on the caller's runtime. */
export function installPython(
  runtime: Runtime,
  options: PythonOptions & { readonly launcher: GuestLauncher },
) {
  return installPrograms(runtime, [createPythonPackage(runtime, options)], {
    launcher: options.launcher,
  });
}
