import type { GuestLauncher, Runtime } from "waffle";
import { installPrograms } from "waffle/programs";
import { createPythonPackage, type PythonOptions } from "./index.ts";
import { pythonLauncher } from "./launcher.ts";

/** Install CPython with its required cwd environment on the caller's runtime. */
export function installPython(
  runtime: Runtime,
  options: PythonOptions & { readonly launcher: GuestLauncher },
) {
  return installPrograms(runtime, [createPythonPackage(runtime, options)], {
    launcher: pythonLauncher(options.launcher),
  });
}
