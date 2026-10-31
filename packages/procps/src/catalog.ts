import { defineProgramPackage } from "waffle/programs/catalog";
import type { Command } from "./model.ts";

const names: readonly Command[] = ["ps", "pgrep", "pkill"];

/** Optional commands. Installation does not load their implementation. */
export const procps = defineProgramPackage({
  name: "procps",
  programs: names.map((name) => ({
    path: `/usr/bin/${name}`,
    aliases: [`/bin/${name}`],
    command: {
      ...(name === "pkill" ? { signals: "delegated" as const } : {}),
      load: async () => (await import("./command.ts")).procpsCommand(name),
    },
  })),
});

export const procpsPrograms = procps.programs;
