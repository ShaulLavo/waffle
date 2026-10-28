import assert from "node:assert/strict";
import observations from "../fixtures/sort-uniq.json" with { type: "json" };
import { sortUniqCases } from "./sort-uniq-cases.ts";

export function loadSortUniqObservations(fixture = observations) {
  assert.equal(fixture.schema, 1);
  assert.equal(
    fixture.oracle.bash.version,
    "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)",
  );
  assert.equal(fixture.oracle.sort.version, "sort (GNU coreutils) 9.12");
  assert.equal(fixture.oracle.uniq.version, "uniq (GNU coreutils) 9.12");
  for (const executable of Object.values(fixture.oracle))
    assert.match(executable.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    fixture.cases.map(({ name, script }) => [name, script]),
    sortUniqCases,
    "Frozen sort/uniq observations must match every case in order",
  );
  for (const entry of fixture.cases) {
    assert.ok(Number.isInteger(entry.status) && entry.status >= 0 && entry.status <= 255);
    assert.equal(typeof entry.stderrPresent, "boolean");
    assert.ok(entry.stdout.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
  }
  return fixture.cases;
}
