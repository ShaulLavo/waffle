import type { ProgramPackage } from "waffle/programs";

export const grep: ProgramPackage = {
  name: "grep",
  programs: [
    {
      path: "/usr/bin/grep",
      aliases: ["/bin/grep"],
      wasm: new URL("../dist/grep.wasm", import.meta.url),
    },
  ],
};
