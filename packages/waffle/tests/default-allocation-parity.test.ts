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
function withoutStorageRoot(value: Parameters<typeof multiset>[0], bytes: number) {
  const events = multiset(value);
  for (const outcome of ["attempt", "success"]) {
    const root = JSON.stringify({
      realm: "page-owned-javascript",
      purpose: "startup",
      constructor: "SharedArrayBuffer",
      descriptor: { initial: bytes, maximum: bytes, growable: false },
      outcome,
    });
    expect(events.filter((event) => event === root)).toHaveLength(1);
    events.splice(events.indexOf(root), 1);
  }
  return events;
}
/** An identity no longer constructs its 95 empty growable data segments. The filesystem owner
 * builds each fixed segment when a page in it is first needed, so startup declares none. */
function withoutEagerSegments(expected: string[]) {
  const segment = (outcome: string) =>
    JSON.stringify({
      realm: "page-owned-javascript",
      purpose: "startup",
      constructor: "SharedArrayBuffer",
      descriptor: { initial: 0, maximum: 16 * 1024 * 1024, growable: true },
      outcome,
    });
  const placeholders = [segment("attempt"), segment("success")];
  for (const placeholder of placeholders)
    expect(expected.filter((event) => event === placeholder)).toHaveLength(95);
  return expected.filter((event) => !placeholders.includes(event));
}
/** Private large inputs shrank the arena maximum and added one word to each request control. */
function withPrivateInputArena(expected: string[]) {
  return expected
    .map((event) =>
      event
        .replaceAll('"maximum":2147479552', '"maximum":134316032')
        .replaceAll(
          '"initial":64,"maximum":64,"growable":false',
          '"initial":72,"maximum":72,"growable":false',
        ),
    )
    .sort();
}
function withoutIdleWorkers(expected: string[]) {
  for (const outcome of ["attempt", "success"]) {
    const idle = JSON.stringify({
      realm: "page-owned-javascript",
      purpose: "guest",
      constructor: "Worker",
      descriptor: { url: "guest-worker", options: { type: "module" } },
      outcome,
    });
    expect(expected.filter((event) => event === idle)).toHaveLength(3);
    expected.splice(expected.indexOf(idle), 2);
  }
  return expected;
}
function withExecutionObservation(expected: string[]) {
  const oldDirectory = '"initial":720928,"maximum":720928,"growable":false';
  expect(expected.filter((event) => event.includes(oldDirectory))).toHaveLength(2);
  const events = expected.map((event) =>
    event.replace(oldDirectory, '"initial":729120,"maximum":729120,"growable":false'),
  );
  for (const purpose of ["connection", "group", "guest"]) {
    for (const outcome of ["attempt", "success"])
      events.push(
        JSON.stringify({
          realm: "page-owned-javascript",
          purpose,
          constructor: "SharedArrayBuffer",
          descriptor: { initial: 16, maximum: 16, growable: false },
          outcome,
        }),
      );
  }
  return events.sort();
}
/** Publication descriptors widened the memory group reply cell from five words to nine. */
function withPublicationReply(expected: string[]) {
  const oldReply = '"initial":20,"maximum":20,"growable":false';
  expect(expected.filter((event) => event.includes(oldReply))).toHaveLength(2);
  return expected
    .map((event) => event.replace(oldReply, '"initial":36,"maximum":36,"growable":false'))
    .sort();
}
for (const [mode, agent] of [
  ["normal", "desktop"],
  ["fallback", "desktop"],
  ["normal", "ios"],
] as const)
  test(`P7 PRE-IMPORT PAGE-OWNED JavaScript descriptors match the reference apart from approved storage, worker and process-control changes, ${mode}, ${agent} user agent`, async () => {
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
      expect(withoutStorageRoot(current, 33_289_256)).toEqual(
        withPublicationReply(
          withExecutionObservation(
            withPrivateInputArena(
              withoutIdleWorkers(
                withoutEagerSegments(withoutStorageRoot(baseline, 64 * 1024 * 1024)),
              ),
            ),
          ),
        ),
      );
      // No page-owned startup construction is a growable buffer sized for a data segment.
      expect(
        multiset(current).filter((event) => event.includes('"maximum":16777216,"growable":true')),
      ).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
