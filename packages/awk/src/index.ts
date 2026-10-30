import { defineProgramPackage, type ProgramCatalog } from "waffle/programs/catalog";

export const awk: ProgramCatalog = defineProgramPackage({
  name: "awk",
  programs: [
    {
      path: "/usr/bin/awk",
      aliases: ["/bin/awk"],
      wasm: new URL("../dist/awk.wasm", import.meta.url),
    },
  ],
});
