import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

for (const mode of ["native", "own", "browser"]) {
  test(`native stream hooks preserve ${mode} host construction`, () => {
    const result = spawnSync("node", [new URL("./native-stream-state-probe.ts", import.meta.url).pathname, mode], {
      encoding: "utf8", timeout: 10000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain(`${mode}: native stream construction and completion passed`);
  });
}
