import { defineProgramPackage } from "@waffle-os/runtime/programs/catalog";
import type { GuestLauncher, Runtime } from "@waffle-os/runtime";
import {
  installPrograms,
  type InstallProgramsOptions,
  type ProgramInstallation,
  type ProgramPackage,
} from "@waffle-os/runtime/programs";
import { coreutils } from "@waffle-os/coreutils";
import { findutils } from "@waffle-os/findutils";
import { grep } from "@waffle-os/grep";
import { ripgrep } from "@waffle-os/ripgrep";
import { sed } from "@waffle-os/sed";

export const basePackages = [
  coreutils,
  findutils,
  grep,
  ripgrep,
  sed,
] as const satisfies readonly ProgramPackage[];

export const basePrograms = basePackages.flatMap((family) => family.programs);
export const base = defineProgramPackage({
  name: "base",
  programs: basePrograms,
  packages: basePackages,
});

export interface BaseInstallOptions {
  readonly launcher: GuestLauncher;
}

export function installBase(
  runtime: Runtime,
  options: BaseInstallOptions,
): Promise<ProgramInstallation> {
  const installOptions: InstallProgramsOptions = { launcher: options.launcher };
  return installPrograms(runtime, basePackages, installOptions);
}
