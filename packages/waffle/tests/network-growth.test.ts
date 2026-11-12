import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

for (const form of ["wasm", "buffer"]) {
  test(`${form} all 136 slabs preserve fragmented full queues and reuse`, () => {
    const output = execFileSync(
      process.execPath,
      [new URL("./network-growth-control.ts", import.meta.url).pathname, form],
      { encoding: "utf8", timeout: 45000 },
    );
    expect(output).toContain('"growthPages":');
    console.log(output.trim());
  }, 50000);
}

for (const form of ["wasm", "buffer"]) {
  for (const mode of ["churn", "envelope"]) {
    test(`${form} ${mode} refuses without allocation and stays healthy`, () => {
      const output = execFileSync(
        process.execPath,
        [new URL("./network-resource-control.ts", import.meta.url).pathname, form, mode],
        { encoding: "utf8", timeout: 15000 },
      );
      expect(output).toContain('"result":"pass"');
    });
  }
}
