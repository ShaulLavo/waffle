import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DESKTOP_REFERENCE_COMMIT as reference,
  requireDesktopReference,
} from "../tooling/prepare-desktop-reference.js";

function capture(root: string, fallback: string) {
  const result = spawnSync(
    process.execPath,
    [new URL("./fixtures/desktop-allocation-capture.ts", import.meta.url).pathname, root, fallback],
    { encoding: "utf8", timeout: 20000 },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
function multiset(capture: { events: { rawURL?: string }[] }) {
  return capture.events.map(({ rawURL: _rawURL, ...event }) => JSON.stringify(event)).sort();
}
for (const mode of ["normal", "fallback"])
  test(`P7 PRE-IMPORT PAGE-OWNED JavaScript descriptors match public main, ${mode}`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "waffle-parity-reference-"));
    try {
      const repository =
        process.env.WAFFLE_PARITY_REFERENCE_GIT ?? resolve(import.meta.dir, "../../..");
      requireDesktopReference(repository);
      const archive = execFileSync("git", ["archive", reference, "packages/waffle"], {
        cwd: repository,
        maxBuffer: 32 * 1024 * 1024,
      });
      execFileSync("tar", ["-x", "-C", scratch], { input: archive });
      const baseline = capture(join(scratch, "packages/waffle"), mode);
      const current = capture(
        process.env.WAFFLE_PARITY_CANDIDATE_ROOT ?? resolve(import.meta.dir, ".."),
        mode,
      );
      const output = process.env.WAFFLE_PARITY_REPORT;
      if (output)
        await writeFile(
          join(output, `P7-${mode}.json`),
          JSON.stringify({ reference, baseline, current }, null, 2),
        );
      expect(current.boundary).toBe("PRE-IMPORT PAGE-OWNED JavaScript");
      expect(current.fixtures).toEqual(baseline.fixtures);
      expect(multiset(current)).toEqual(multiset(baseline));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
