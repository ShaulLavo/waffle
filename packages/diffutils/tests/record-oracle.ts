import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { diffutilsCases } from "./cases.ts";
import { writeFixtures } from "./fixtures.ts";
import { executeNative, nativeVersion, type Executables, type Oracle } from "./oracle.ts";

const root = resolve(import.meta.dirname, "..");
const build = resolve(root, ".build");
mkdirSync(build, { recursive: true });
const scratch = mkdtempSync(resolve(build, "record-oracle-"));
const executables: Executables = {
  diff: process.env.GNU_DIFF ?? "diff",
  cmp: process.env.GNU_CMP ?? "cmp",
};

try {
  writeFixtures(scratch);
  const oracle: Oracle = {
    schemaVersion: 1,
    nativeVersions: {
      diff: nativeVersion(executables.diff, "diff"),
      cmp: nativeVersion(executables.cmp, "cmp"),
    },
    cases: Object.fromEntries(
      diffutilsCases.map((fixture) => {
        const actual = executeNative(scratch, executables, fixture);
        if (actual.exit !== fixture.exit) {
          throw new Error(`${fixture.name}: native exit ${actual.exit}, expected ${fixture.exit}`);
        }
        return [fixture.name, actual];
      }),
    ),
  };
  writeFileSync(
    resolve(import.meta.dirname, "diffutils-oracle.json"),
    `${JSON.stringify(oracle, null, 2)}\n`,
  );
  console.log(`Recorded ${diffutilsCases.length} GNU diffutils oracle cases`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
