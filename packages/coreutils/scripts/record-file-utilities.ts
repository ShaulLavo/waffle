import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  fileUtilityCases,
  fileUtilityMetadataGap,
  fileUtilityNames,
} from "../tests/helpers/file-utility-cases.ts";
import { recordFileUtilityCase } from "./file-utilities-recording.ts";

const bash = process.argv[2];
assert.ok(bash, "Pass the approved Bash 5.3.15 binary path");
async function identity(path: string) {
  return {
    path,
    version: execFileSync(path, ["--version"], { encoding: "utf8" }).split("\n")[0],
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}
const oracle = await identity(bash);
assert.match(oracle.version, /^GNU bash, version 5\.3\.15\(1\)-release /);
const coreutils = Object.fromEntries(
  await Promise.all(
    fileUtilityNames.map(async (name) => [name, await identity(`/usr/bin/${name}`)]),
  ),
);
const cases = [];
for (const example of fileUtilityCases)
  cases.push({ ...example, ...(await recordFileUtilityCase(bash, example.script)) });
const runtimeGaps = [
  {
    ...fileUtilityMetadataGap,
    ...(await recordFileUtilityCase(bash, fileUtilityMetadataGap.script)),
  },
];
const receipt = { schema: 1, bash: oracle, coreutils, cases, runtimeGaps };
await writeFile(
  new URL("../fixtures/file-utilities.json", import.meta.url),
  JSON.stringify(receipt, null, 2) + "\n",
  { flag: "wx" },
);
