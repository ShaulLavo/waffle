import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const script = new URL("../../env.sh", import.meta.url).pathname;
for (const override of [undefined, "/explicit/browser-cache", "0", ""]) {
  test(`toolchain browser cache ${override === undefined ? "default" : JSON.stringify(override)}`, () => {
    const env = { ...process.env };
    if (override === undefined) delete env.PLAYWRIGHT_BROWSERS_PATH;
    else env.PLAYWRIGHT_BROWSERS_PATH = override;
    const result = spawnSync("bash", ["-c", 'source "$1"; printf "%s\\n%s" "${PLAYWRIGHT_BROWSERS_PATH+x}" "${PLAYWRIGHT_BROWSERS_PATH-}"', "bash", script], { env, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const expected = override ?? (existsSync("/work/cache/ms-playwright") ? "/work/cache/ms-playwright" : undefined);
    expect(result.stdout).toBe(expected === undefined ? "\n" : `x\n${expected}`);
  });
}
