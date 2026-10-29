import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

test("runtime disposal with unsettled socket cleanup rejects and keeps the filesystem", () => {
  const script = new URL("./fixtures/network-fence-script.ts", import.meta.url).pathname;
  const output = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 20_000 });
  expect(output).toContain("fence retained filesystem after socket cleanup failure");
});
