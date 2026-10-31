import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fixtureFiles } from "./cases.ts";

export function writeFixtures(root: string) {
  for (const [path, contents] of Object.entries(fixtureFiles)) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
    utimesSync(destination, 1_577_934_245, 1_577_934_245);
  }
}
