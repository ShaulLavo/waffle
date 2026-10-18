import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/process-cell-clone.ts", import.meta.url));

for (const [mode, description] of [
  ["instances", "directory cell instances are cloneable in real Node workerData"],
  ["instances-after-exit", "Node worker exit does not reject an undrained MessagePort reply"],
  ["no-reply", "a Node worker closing its reply port without replying rejects the waiter"],
  ["process", "Node Worker and MessagePort process cells reject collection before and after slot reuse"],
  ["job", "Node Worker and MessagePort job cells retain a lifecycle identity distinct from the leader pid"],
  ["broker", "the generic process broker spawns and waits for a real Node worker with serialized consumer signals"],
] as const) {
  test(description, () => {
    // Bun's node:worker_threads implementation is not the Node structured-clone
    // boundary. Run TypeScript fixtures under Node, using prepare's JS modules.
    const output = execFileSync("node", [fixture, mode], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10_000,
    });
    expect(output.trim()).toBe(`ok ${mode}`);
  }, 15_000);
}
