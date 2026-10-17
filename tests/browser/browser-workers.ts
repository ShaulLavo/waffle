import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile, run } from "./playground.mjs";
import { workerReviewCases } from "../../tests/fixtures/worker-review/cases.ts";

const fixture = new URL("../../tests/fixtures/worker-execution/", import.meta.url);
const files = ["index.ts", "worker.ts", "preload.cjs"].map(name => ({
  name, source: readFileSync(new URL(name, fixture), "utf8"),
}));
const expected = readFileSync(new URL("expected.txt", fixture), "utf8").trim().split("\n");
const closure = new URL("../../tests/fixtures/worker-port-closure/", import.meta.url);
const closeSource = readFileSync(new URL("index.ts", closure), "utf8");
const closeExpected = readFileSync(new URL("expected.txt", closure), "utf8").trim().split("\n");

export async function checkWorkers(page: Parameters<typeof writeFile>[0], label: string) {
  for (const file of files) await writeFile(page, `/home/user/${file.name}`, file.source);
  const result = await run(page, "bun run index.ts", 120000);
  assert.equal(result.code, 0, `${label}\n${result.output}`);
  for (const line of expected) assert.ok(result.output.includes(line), `${label}: missing ${line}\n${result.output}`);
  await writeFile(page, "/home/user/port-closure.ts", closeSource);
  const closed = await run(page, "bun run port-closure.ts");
  assert.equal(closed.code, 0, `${label}\n${closed.output}`);
  for (const line of closeExpected) assert.ok(closed.output.includes(line), `${label}: missing ${line}\n${closed.output}`);
  for (const test of workerReviewCases) {
    await writeFile(page, "/home/user/worker-review.ts", test.code);
    const checked = await run(page, "bun run worker-review.ts", 120000);
    assert.equal(checked.code, test.exit, `${label} ${test.name}\n${checked.output}`);
    for (const line of test.output) assert.ok(checked.output.includes(line), `${label} ${test.name}: missing ${line}\n${checked.output}`);
    if (test.error) assert.ok(checked.output.includes(test.error), checked.output);
  }
  console.log(`ok ${label}: isolated Worker guests, transfers, lifecycle, nested workers, termination and stdio`);
}
