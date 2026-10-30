import { defineProgramPackage, type ProgramCatalog } from "waffle/programs/catalog";

export const GH_CLI_URL = new URL("../dist/gh-cli.js", import.meta.url);

/** The gh script borrows this registered interpreter. jq remains a separately installed program. */
export function createGhPackage(options: {
  readonly interpreter: string;
  readonly source?: () => Promise<string>;
}): ProgramCatalog {
  return defineProgramPackage({
    name: "gh",
    programs: [
      {
        path: "/usr/bin/gh",
        aliases: ["/bin/gh"],
        script: { interpreter: options.interpreter, source: options.source ?? ghSource },
      },
    ],
  });
}

async function ghSource(): Promise<string> {
  const response = await fetch(GH_CLI_URL);
  if (!response.ok) throw new Error(`gh script fetch failed: ${response.status}`);
  return response.text();
}
