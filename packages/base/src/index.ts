import type { GuestLauncher, Runtime } from "waffle";
import {
  installPrograms,
  defineProgramPackage,
  type InstallProgramsOptions,
  type ProgramInstallation,
  type ProgramPackage,
} from "waffle/programs";
import { coreutils } from "waffle-coreutils";
import { findutils } from "waffle-findutils";
import { grep } from "waffle-grep";
import { ripgrep } from "waffle-ripgrep";
import { sed } from "waffle-sed";

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
