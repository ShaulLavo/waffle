import { defineProgramPackage } from "waffle/programs/catalog";

const names = [
  "env",
  "clear",
  "cat",
  "cut",
  "tr",
  "head",
  "nl",
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
  "date",
  "b2sum",
  "cksum",
  "md5sum",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "sum",
] as const;

export const coreutils = defineProgramPackage({
  name: "coreutils",
  programs: names.map((name) => ({
    path: `/usr/bin/${name}`,
    aliases: [`/bin/${name}`],
    wasm: new URL(`../dist/${name}.wasm`, import.meta.url),
  })),
});

export const coreutilsPrograms = coreutils.programs;
