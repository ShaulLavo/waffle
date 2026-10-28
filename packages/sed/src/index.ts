import type { ProgramPackage } from "waffle/programs";

export const sed: ProgramPackage = {
  name: "sed",
  programs: [
    {
      path: "/usr/bin/sed",
      aliases: ["/bin/sed"],
      wasm: new URL("../dist/sed.wasm", import.meta.url),
    },
  ],
};
