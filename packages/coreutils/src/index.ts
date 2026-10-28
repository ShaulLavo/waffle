import type { ProgramPackage } from "waffle/programs";

const names = [
  "env",
  "clear",
  "cat",
  "cut",
  "tr",
  "head",
  "which",
  "ls",
  "mkdir",
  "seq",
  "sort",
  "tail",
  "uniq",
  "wc",
  "touch",
  "rm",
  "cp",
  "mv",
  "echo",
] as const;

export const coreutils: ProgramPackage = {
  name: "coreutils",
  programs: names.map((name) => ({
    path: `/usr/bin/${name}`,
    aliases: [`/bin/${name}`],
    wasm: new URL(`../dist/${name}.wasm`, import.meta.url),
  })),
};

export const coreutilsPrograms = coreutils.programs;
