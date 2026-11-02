import { defineProgramPackage } from "waffle/programs/catalog";

/** Optional upstream tar. The WASI metadata limits are explicit command failures. */
export const tar = defineProgramPackage({
  name: "tar",
  programs: [
    {
      path: "/usr/bin/tar",
      aliases: ["/bin/tar"],
      wasm: new URL("../dist/tar.wasm", import.meta.url),
    },
  ],
});
