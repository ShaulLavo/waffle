import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fixture from "../../fixtures/cut-tr.json" with { type: "json" };
import sources from "../../sources.lock.json" with { type: "json" };
import { cutTrCases } from "./cut-tr-cases.ts";

export function cutTrRecording(recording = fixture) {
  const provenance = sources.shellCutTrQualification;
  assert.equal(recording.schema, 1);
  assert.deepEqual(recording.oracle, provenance.oracle);
  assert.deepEqual(recording.environment, provenance.environment);
  assert.deepEqual(
    recording.cases.map(({ name, script }) => [name, script]),
    cutTrCases,
    "cut/tr recording must match the complete ordered matrix",
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(recording, null, 2) + "\n")
    .digest("hex");
  assert.equal(digest, provenance.fixture.sha256, "cut/tr recording digest mismatch");
  return recording;
}
