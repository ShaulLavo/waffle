import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("production Node image verification settles and cancels failed streams", () => {
  const fixture = fileURLToPath(new URL("./fixtures/relay-image-lifecycle.ts", import.meta.url));
  const output = execFileSync("node", [fixture], { encoding: "utf8", timeout: 12000 });
  expect(output).toContain("PASS Node failure settlement and owned-child cleanup");
}, 15000);
