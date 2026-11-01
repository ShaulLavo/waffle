import { expect, test } from "bun:test";
import { closeSync, openSync, readFileSync } from "node:fs";
import { processState } from "./fixtures/process-state.ts";

test("the cleanup observer does not classify a live process as stopped", () => {
  const state = processState(`/proc/${process.pid}/stat`);
  expect(state).toBeDefined();
  expect(state).not.toBe("Z");
});

test("the cleanup observer accepts an absent process", () => {
  expect(processState("/proc/-1/stat")).toBeUndefined();
});

test("the cleanup observer accepts a process that exits after its stat file opens", async () => {
  const child = Bun.spawn(["/bin/sh", "-c", "kill -STOP $$"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let descriptor: number | undefined;
  try {
    const opened = openSync(`/proc/${child.pid}/stat`, "r");
    descriptor = opened;
    child.kill("SIGKILL");
    await child.exited;
    expect(() => readFileSync(opened, "utf8")).toThrow(/ESRCH/);
    expect(processState(opened)).toBeUndefined();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    if (descriptor !== undefined) closeSync(descriptor);
  }
});

test("the cleanup observer does not hide unrelated filesystem errors", () => {
  expect(() => processState("/proc")).toThrow();
});
