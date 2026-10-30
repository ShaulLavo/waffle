import { defineProgramPackage, type ProgramCatalog } from "waffle/programs";

export const diffutils: ProgramCatalog = defineProgramPackage({
  name: "diffutils",
  programs: [
    {
      path: "/usr/bin/diff",
      aliases: ["/bin/diff"],
      wasm: new URL("../dist/diff.wasm", import.meta.url),
    },
    {
      path: "/usr/bin/cmp",
      aliases: ["/bin/cmp"],
      wasm: new URL("../dist/cmp.wasm", import.meta.url),
    },
  ],
});
