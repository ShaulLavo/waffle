import type { ProgramPackage } from "waffle/programs";

export const ripgrep: ProgramPackage = {
  name: "ripgrep",
  programs: [
    {
      path: "/usr/bin/rg",
      aliases: ["/bin/rg"],
      wasm: new URL("../dist/rg.wasm", import.meta.url),
    },
  ],
};
