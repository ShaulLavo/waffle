import {test, expect} from "bun:test";
import {spawnSync} from "node:child_process";
test("Node key conversion, native interop and padding validation", () => {
  const result = spawnSync("node", ["--no-warnings", new URL("./crypto-key-adapter-probe.mjs", import.meta.url).pathname], {encoding:"utf8", timeout:10000});
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.match(/^PASS /gm)).toHaveLength(20);
  expect(result.stdout).toContain("failures 0");
});
