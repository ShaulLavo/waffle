import {test, expect} from "bun:test";
import {spawnSync} from "node:child_process";
test("native crypto settles before host exit", () => {
  const result = spawnSync("node", [new URL("./crypto-lifetime-probe.mjs", import.meta.url).pathname], {encoding:"utf8", timeout:10000});
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("native SubtleCrypto keeps the host alive");
});
test("unhandled native crypto rejection remains fatal", () => {
  const result = spawnSync("node", [new URL("./crypto-lifetime-probe.mjs", import.meta.url).pathname], {encoding:"utf8", timeout:10000, env:{...process.env, NATIVE_CRYPTO_REJECT:"1"}});
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("native rejection TypeError");
});
