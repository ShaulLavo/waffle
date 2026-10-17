import {test,expect} from "bun:test";
import {spawnSync} from "node:child_process";
test("native crypto rejects oversized buffers before copying", () => {
  const result = spawnSync("node",["--no-warnings",new URL("./crypto-inputs-probe.mjs",import.meta.url).pathname],{encoding:"utf8",timeout:10000});
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("oversized input guards 12");
});
