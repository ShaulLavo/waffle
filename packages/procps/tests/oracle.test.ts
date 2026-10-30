import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import oracle from "../fixtures/oracle.json";
import { planProcps, type ProcessRow } from "../src/index.ts";

const unsupported = new Set([
  "ps.output.full-format",
  "ps.output.no-headers",
  "ps.output.forest",
  "ps.output.native-stat-fields",
  "ps.parser.invalid-option",
  "pgrep.select.oldest",
  "pgrep.select.newest",
  "pkill.signal-zero.exact-name",
  "pkill.signal-zero.full-command",
  "pkill.signal-zero.newest",
  "pkill.match.no-match",
  "pkill.parser.invalid-regex",
]);

function rowsFor(probe: (typeof oracle.cases)[number]): ProcessRow[] {
  const fixtures = oracle.controlledInput.fixtures;
  const rows = fixtures
    .filter(
      (fixture) => probe.id !== "pgrep.match.after-owned-termination" || fixture.label !== "delta",
    )
    .map((fixture) => ({
      pid: fixture.pid,
      parentPid: oracle.controlledInput.collectorPid,
      comm: fixture.name,
      args: fixture.argv.join(" "),
    }));
  if (probe.id === "ps.selection.parent")
    rows.push({
      pid: probe.commandPid,
      parentPid: oracle.controlledInput.collectorPid,
      comm: "ps",
      args: ["ps"].concat(probe.argv).join(" "),
    });
  return rows;
}

for (const probe of oracle.cases) {
  test(`recorded native case: ${probe.id}`, () => {
    if (probe.program !== "ps" && probe.program !== "pgrep" && probe.program !== "pkill")
      throw new Error("unknown oracle program");
    if (probe.status !== 0 && probe.status !== 1 && probe.status !== 2)
      throw new Error("unexpected oracle status");
    const result = planProcps({
      command: probe.program,
      argv: probe.argv,
      processes: rowsFor(probe),
      selfPid: probe.commandPid,
    });
    if (unsupported.has(probe.id)) {
      expect(result).toMatchObject({ kind: "unsupported", stdout: "" });
      return;
    }
    if (probe.id === "pkill.signal.term-one-owned-child") {
      const pids = probe.safety?.selectedPids;
      if (!pids) throw new Error("TERM oracle must retain its guarded target receipt");
      expect(result).toEqual({ kind: "signal", signal: 15, pids });
      return;
    }
    if (probe.id === "pkill.parser.invalid-signal") {
      expect(result).toMatchObject({ kind: "output", status: probe.status, stdout: probe.stdout });
      return;
    }
    expect(result).toEqual({
      kind: "output",
      status: probe.status,
      stdout: probe.stdout,
      stderr: probe.stderr,
    });
  });
}

test("all 37 original observations and normalization boundaries remain byte-for-byte unchanged", () => {
  const hash = (path: string) =>
    createHash("sha256")
      .update(readFileSync(new URL(path, import.meta.url)))
      .digest("hex");
  expect(hash("../fixtures/oracle.json")).toBe(
    "59465041176775ba2d111bf58eac5f72642d91e836c2d5e197c94f2041adb22d",
  );
  expect(hash("../fixtures/survey-priority.json")).toBe(
    "6e3ad9879b817f829fd84b5882d5e4f4ff5d815eb8a6b5234faa084bd24b8b0f",
  );
  expect(oracle.cases).toHaveLength(37);
  expect(oracle.failures).toEqual([]);
  expect(oracle.cleanup.remainingOwnedPids).toEqual([]);
  expect(oracle.cleanup.remainingProcPids).toEqual([]);
  expect(oracle.cleanup.fixtureDirectoryRemoved).toBe(true);
});
