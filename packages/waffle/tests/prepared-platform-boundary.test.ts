import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
test("prepared integration callers never import the source-only platform fixture", () => {
  const files = execFileSync("git", ["ls-files", "-z", "*.ts"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const findings = files
    .filter((path) => !path.startsWith("packages/waffle/"))
    .filter((path) =>
      readFileSync(resolve(root, path), "utf8").includes("/tests/fixtures/shared-memory-platform."),
    );
  expect(findings).toEqual([]);
});
for (const mode of ["default", "bounded", "unbounded"])
  test(`prepared package-root ${mode} startup uses one issuance authority and rejects foreign objects`, () => {
    const result = spawnSync(
      process.execPath,
      [new URL("./fixtures/prepared-runtime-control.ts", import.meta.url).pathname, mode],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
