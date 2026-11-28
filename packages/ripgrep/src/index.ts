import { defineProgramPackage } from "@waffle-os/runtime/programs/catalog";

export const ripgrep = defineProgramPackage({
  name: "ripgrep",
  programs: [
    {
      path: "/usr/bin/rg",
      aliases: ["/bin/rg"],
      wasm: new URL("../dist/rg.wasm", import.meta.url),
    },
  ],
});
