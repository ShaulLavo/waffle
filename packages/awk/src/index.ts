import { defineProgramPackage } from "@waffle-os/runtime/programs/catalog";

export const awk = defineProgramPackage({
  name: "awk",
  programs: [
    {
      path: "/usr/bin/awk",
      aliases: ["/bin/awk"],
      wasm: new URL("../dist/awk.wasm", import.meta.url),
    },
  ],
});
