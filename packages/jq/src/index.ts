import { defineProgramPackage, type ProgramCatalog } from "waffle/programs";

export const jq: ProgramCatalog = defineProgramPackage({
  name: "jq",
  programs: [
    {
      path: "/usr/bin/jq",
      aliases: ["/bin/jq"],
      wasm: new URL("../dist/jq.wasm", import.meta.url),
    },
  ],
});
