import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
for (const mode of [
  "throw",
  "abandoned",
  "late-unbounded",
  "late-bounded",
  "pending",
  "failed-wait",
])
  test(`Runtime retains owned display retirement on ${mode}`, () => {
    const script = new URL("./fixtures/gpu/runtime-display-fence-launcher.ts", import.meta.url)
      .pathname;
    const output = execFileSync(process.execPath, [script, mode], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(output).toContain(`display ${mode} retains the actual Runtime guard and filesystem`);
  });
