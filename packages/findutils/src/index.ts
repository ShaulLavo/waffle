import type { ProgramPackage } from "waffle/programs";

export const findutils: ProgramPackage = {
  name: "findutils",
  programs: [
    {
      path: "/usr/bin/find",
      aliases: ["/bin/find"],
      wasm: new URL("../dist/find.wasm", import.meta.url),
    },
    {
      path: "/usr/bin/xargs",
      aliases: ["/bin/xargs"],
      wasm: new URL("../dist/xargs.wasm", import.meta.url),
    },
  ],
};
