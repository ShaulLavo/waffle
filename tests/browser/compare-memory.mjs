import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
assert.ok(beforePath && afterPath, "usage: node web/tests/compare-memory.mjs before.json after.json");
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));
assert.deepEqual(before.wasmBuilds, after.wasmBuilds, "measure identical wasm artifacts");
assert.equal(typeof before.hostWorkerSha256, "string");
assert.equal(typeof after.hostWorkerSha256, "string");
assert.notEqual(before.hostWorkerSha256, after.hostWorkerSha256, "compare the changed host bundles");
assert.equal(before.runs, after.runs);
assert.equal(before.nativeCalls, after.nativeCalls);
assert.equal(before.writes, after.writes);
const metrics = {
  "navigation to ready": (sample) => sample.readyMs,
  "50,000 native calls (guest)": (sample) => sample.native.guestMs,
  "50,000 string native calls (guest)": (sample) => sample.nativeString.guestMs,
  "2,000 console writes (guest)": (sample) => sample.fdWrite.guestMs,
  "50,000 native calls (wall)": (sample) => sample.native.wallMs,
  "50,000 string native calls (wall)": (sample) => sample.nativeString.wallMs,
  "2,000 console writes (wall)": (sample) => sample.fdWrite.wallMs,
  "sandbox first render": (sample) => sample.firstRenderMs,
};
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log("| Browser | Workload | Before median ms | After median ms | Change |\n|---|---|---:|---:|---:|");
const commits = [];
for (const previous of before.results) compare(previous);
console.log("\n" + commits.join("\n"));

function compare(previous) {
  const next = after.results.find((result) => result.browser === previous.browser);
  assert.ok(next, previous.browser);
  assert.equal(next.version, previous.version);
  const previousCommits = previous.samples.map((sample) => sample.renderCommits);
  const nextCommits = next.samples.map((sample) => sample.renderCommits);
  assert.ok(previousCommits.concat(nextCommits).every((count) => Number.isInteger(count) && count > 0), "measure React root commits");
  assert.deepEqual(nextCommits, previousCommits, "compare equal React root commits");
  commits.push(`${next.browser} React root commits: before ${previousCommits.join(",")}; after ${nextCommits.join(",")}.`);
  for (const [label, metric] of Object.entries(metrics)) {
    const a = median(previous.samples.map(metric));
    const b = median(next.samples.map(metric));
    console.log(`| ${next.browser} | ${label} | ${a.toFixed(2)} | ${b.toFixed(2)} | ${((b / a - 1) * 100).toFixed(1)}% |`);
  }
}
