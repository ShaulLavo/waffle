import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function discover(file: string, pattern = "^$") {
  const env = { ...process.env };
  delete env.NATIVE_CURL;
  delete env.CURL_NATIVE_SCRATCH_ROOT;
  return spawnSync(
    process.execPath,
    ["test", join(import.meta.dir, file), "--test-name-pattern", pattern],
    {
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

test("native command controls run without a curl oracle or its scratch root", () => {
  const result = discover(
    "native-command.test.ts",
    "^pre-aborted and actively aborted native commands stop$",
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("1 pass");
});

test("genuine curl oracle suites still require their explicit prerequisite during discovery", () => {
  for (const entry of [
    { file: "native-oracle-cache.test.ts", error: "NATIVE_CURL is required" },
    {
      file: "native-oracle.test.ts",
      error: "NATIVE_CURL must explicitly name the validated absolute oracle path",
    },
  ]) {
    const result = discover(entry.file);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(entry.error);
  }
});
