import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../scripts/native-oracle.ts";
import { processState } from "./fixtures/process-state.ts";

const roots: string[] = [];
const signal = () => AbortSignal.timeout(5000);
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "curl-native-command-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

test("deadline stops the shell and its child, not just the parent", async () => {
  const root = scratch();
  const pids = join(root, "pids");
  await expect(
    command(
      "/bin/sh",
      ["-c", 'echo $$ > "$1"; sleep 60 & echo $! >> "$1"; wait', "oracle-control", pids],
      root,
      signal(),
      100,
    ),
  ).rejects.toThrow("deadline");
  const observed = readFileSync(pids, "utf8").trim().split("\n");
  expect(observed).toHaveLength(2);
  for (const pid of observed) {
    const path = `/proc/${pid}/stat`;
    const state = processState(path);
    expect(state === undefined || state === "Z", `PID ${pid} state ${state ?? "absent"}`).toBe(
      true,
    );
  }
});

test("pre-aborted and actively aborted native commands stop", async () => {
  const root = scratch();
  const marker = join(root, "executed");
  expect(() => command("/usr/bin/touch", [marker], root, AbortSignal.abort())).toThrow();
  expect(existsSync(marker)).toBe(false);
  await expect(command("/usr/bin/sleep", ["60"], root, AbortSignal.timeout(30))).rejects.toThrow(
    "aborted",
  );
});
