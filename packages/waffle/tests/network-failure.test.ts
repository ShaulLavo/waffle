import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

for (const mode of ["initial", "metadata", "first", "later", "runtime"]) {
  test(`translated owner ${mode} failure retires without export reentry`, () => {
    const control = new URL("./network-failure-control.ts", import.meta.url).pathname;
    const output = execFileSync(process.execPath, [control, mode], {
      encoding: "utf8",
      timeout: 15000,
    });
    console.log(output.trim());
    expect(output).toContain('"entries":');
  });
}
