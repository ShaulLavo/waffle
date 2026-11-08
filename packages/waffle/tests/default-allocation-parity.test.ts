import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ALLOCATION_REFERENCE_COMMIT as reference,
  requireAllocationReference,
} from "../tooling/prepare-allocation-reference.js";

function capture(root: string, fallback: string, agent = "desktop") {
  const result = spawnSync(
    process.execPath,
    [
      new URL("./fixtures/default-allocation-capture.ts", import.meta.url).pathname,
      root,
      fallback,
      agent,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
function multiset(capture: { events: { rawURL?: string }[] }) {
  return capture.events.map(({ rawURL: _rawURL, ...event }) => JSON.stringify(event)).sort();
}
function demandOnlyReference(capture: { events: { rawURL?: string }[] }) {
  const expected = multiset(capture);
  for (const outcome of ["attempt", "success"]) {
    const idle = JSON.stringify({
      realm: "page-owned-javascript",
      purpose: "guest",
      constructor: "Worker",
      descriptor: { url: "guest-worker", options: { type: "module" } },
      outcome,
    });
    expect(expected.filter((event) => event === idle)).toHaveLength(3);
    const first = expected.indexOf(idle);
    expected.splice(first, 2);
  }
  return expected;
}
for (const [mode, agent] of [
  ["normal", "desktop"],
  ["fallback", "desktop"],
  ["normal", "ios"],
] as const)
  test(`P7 PRE-IMPORT PAGE-OWNED JavaScript descriptors match the reference without idle workers, ${mode}, ${agent} user agent`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "waffle-parity-reference-"));
    try {
      const repository =
        process.env.WAFFLE_PARITY_REFERENCE_GIT ?? resolve(import.meta.dir, "../../..");
      requireAllocationReference(repository);
      const archive = execFileSync("git", ["archive", reference, "packages/waffle"], {
        cwd: repository,
        maxBuffer: 32 * 1024 * 1024,
      });
      execFileSync("tar", ["-x", "-C", scratch], { input: archive });
      const baseline = capture(join(scratch, "packages/waffle"), mode);
      const current = capture(
        process.env.WAFFLE_PARITY_CANDIDATE_ROOT ?? resolve(import.meta.dir, ".."),
        mode,
        agent,
      );
      const output = process.env.WAFFLE_PARITY_REPORT;
      if (output)
        await writeFile(
          join(output, `P7-${mode}-${agent}.json`),
          JSON.stringify({ reference, baseline, current }, null, 2),
        );
      expect(current.boundary).toBe("PRE-IMPORT PAGE-OWNED JavaScript");
      expect(current.fixtures).toEqual(baseline.fixtures);
      expect(multiset(current)).toEqual(demandOnlyReference(baseline));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
