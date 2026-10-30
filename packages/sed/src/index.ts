import { defineProgramPackage } from "waffle/programs/catalog";

export const sed = defineProgramPackage({
  name: "sed",
  programs: [
    {
      path: "/usr/bin/sed",
      aliases: ["/bin/sed"],
      wasm: new URL("../dist/sed.wasm", import.meta.url),
    },
  ],
});
