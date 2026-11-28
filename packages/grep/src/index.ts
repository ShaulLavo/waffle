import { defineProgramPackage } from "@waffle-os/runtime/programs/catalog";

export const grep = defineProgramPackage({
  name: "grep",
  programs: [
    {
      path: "/usr/bin/grep",
      aliases: ["/bin/grep"],
      wasm: new URL("../dist/grep.wasm", import.meta.url),
    },
  ],
});
