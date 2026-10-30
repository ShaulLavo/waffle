import { expect, test } from "bun:test";
import { planProcps, processRows, type ProcessInput, type ProcessRow } from "../src/index.ts";
import { compilePattern } from "../src/pattern.ts";

const rows: readonly ProcessRow[] = [
  { pid: 30, parentPid: 1, comm: "worker", args: "/bin/worker --app alpha" },
  {
    pid: 20,
    parentPid: 1,
    comm: "worker-long-command",
    args: "/bin/worker-long-command --app beta",
  },
  { pid: 10, parentPid: 2, comm: "other", args: "/bin/other worker" },
];
const plan = (command: "ps" | "pgrep" | "pkill", argv: readonly string[], processes = rows) =>
  planProcps({ command, argv, processes, selfPid: 99 });

function processRecord(pid: number, patch: Partial<ProcessInput> = {}): ProcessInput {
  return {
    pid,
    parentPid: 1,
    state: "running",
    result: null,
    request: {
      executable: "/bin/worker",
      argv: ["changed-argv0", "a b"],
      cwd: "/app",
      env: { PRIVATE: "not copied" },
      job: -1,
      fds: [],
    },
    ...patch,
  };
}

test("snapshot excludes roots and all terminal records, derives name from executable, and retains only displayed fields", () => {
  const records = [
    processRecord(1, { request: null }),
    processRecord(2, { state: "exited" }),
    processRecord(3, { result: { kind: "signaled", code: 15, status: 15 } }),
    processRecord(4, { state: "reserved" }),
    processRecord(5, { state: "starting" }),
  ];
  expect(processRows(records)).toEqual([
    { pid: 4, parentPid: 1, comm: "worker", args: "changed-argv0 a b" },
    { pid: 5, parentPid: 1, comm: "worker", args: "changed-argv0 a b" },
  ]);
  expect(records[3]?.request?.argv).toEqual(["changed-argv0", "a b"]);
});

test("ps additive PID, command, and parent selectors do not mutate the borrowed snapshot", () => {
  expect(plan("ps", ["-p10", "-C", "worker", "--ppid=1", "-o", "pid=", "--sort=-pid"])).toEqual({
    kind: "output",
    status: 0,
    stdout: "     30\n     20\n     10\n",
    stderr: "",
  });
  expect(rows.map((row) => row.pid)).toEqual([30, 20, 10]);
});

test("ps -eo, explicit headings, and repeated sort keys use real fields only", () => {
  expect(plan("ps", ["-eo", "pid=ID,ppid=PARENT,comm=NAME", "--sort=ppid,-pid"])).toEqual({
    kind: "output",
    status: 0,
    stdout:
      "     ID  PARENT NAME\n     30       1 worker\n     20       1 worker-long-command\n     10       2 other\n",
    stderr: "",
  });
  expect(plan("ps", ["-p", "404", "-o", "pid="])).toEqual({
    kind: "output",
    status: 1,
    stdout: "",
    stderr: "",
  });
});

test("ps missing selection, default output, native stats, age sorting, and forest are explicit unsupported results", () => {
  for (const argv of [
    ["-o", "pid"],
    ["-e"],
    ["-e", "-o", "pid,rss"],
    ["-e", "-o", "pid", "--sort=start_time"],
    ["-e", "-o", "pid", "--forest"],
  ]) {
    expect(plan("ps", argv)).toMatchObject({ kind: "unsupported", status: 1, stdout: "" });
  }
});

test("pgrep name versus full command, listing, exactness, and self exclusion", () => {
  expect(plan("pgrep", ["-axf", "/bin/other worker"])).toEqual({
    kind: "output",
    status: 0,
    stdout: "10 /bin/other worker\n",
    stderr: "",
  });
  expect(plan("pgrep", ["-x", "work"])).toMatchObject({ status: 1, stdout: "" });
  expect(plan("pgrep", ["-P1", "-li", "WORKER"])).toMatchObject({
    status: 0,
    stdout: "20 worker-long-com\n30 worker\n",
  });
  expect(
    planProcps({ command: "pgrep", argv: ["-f", ".*"], processes: rows, selfPid: 10 }),
  ).toMatchObject({ stdout: "20\n30\n" });
});

test("long names are byte-bounded for name matching, while -f is not", () => {
  expect(plan("pgrep", ["-x", "worker-long-com"])).toMatchObject({ status: 0, stdout: "20\n" });
  expect(plan("pgrep", ["-fx", "/bin/worker-long-command --app beta"])).toMatchObject({
    status: 0,
    stdout: "20\n",
  });
});

test("pgrep requires a pattern or parent selector, and count zero still exits 1", () => {
  expect(plan("pgrep", [])).toMatchObject({ status: 2, stdout: "" });
  expect(plan("pgrep", ["-c", "absent"])).toEqual({
    kind: "output",
    status: 1,
    stdout: "0\n",
    stderr: "",
  });
  expect(plan("pgrep", ["--parent", "1"])).toMatchObject({ status: 0, stdout: "20\n30\n" });
});

test("parser failures and unsupported capabilities select no targets", () => {
  for (const command of ["pgrep", "pkill"] as const) {
    expect(plan(command, ["["])).toEqual({
      kind: "output",
      status: 2,
      stdout: "",
      stderr: `${command}: regex error: Invalid regular expression\n`,
    });
    expect(plan(command, ["-P", "1,no", "worker"])).toMatchObject({ kind: "output", status: 2 });
    expect(plan(command, ["--newest", "worker"])).toMatchObject({ kind: "unsupported", status: 2 });
    expect(plan(command, ["-u", "owner", "worker"])).toMatchObject({
      kind: "unsupported",
      status: 2,
    });
  }
});

test("pkill produces an inert signal plan, never a successful delivery receipt", () => {
  expect(plan("pkill", ["-P1", "-TERM", "-x", "worker"])).toEqual({
    kind: "signal",
    signal: 15,
    pids: [30],
  });
  expect(plan("pkill", ["--signal=SIGINT", "-f", "worker"])).toEqual({
    kind: "signal",
    signal: 2,
    pids: [10, 20, 30],
  });
  expect(plan("pkill", ["-9", "-P", "1", "worker"])).toMatchObject({
    kind: "signal",
    signal: 9,
    pids: [20, 30],
  });
  expect(plan("pkill", ["-PIPE", "-x", "worker"])).toMatchObject({
    kind: "signal",
    signal: 13,
    pids: [30],
  });
  expect(plan("pkill", ["worker"], [])).toEqual({
    kind: "output",
    status: 1,
    stdout: "",
    stderr: "",
  });
  expect(plan("pkill", ["-HUP", "worker"])).toMatchObject({ kind: "unsupported", status: 2 });
  expect(plan("pkill", ["-0", "worker"])).toMatchObject({ kind: "unsupported", status: 2 });
  expect(plan("pkill", ["--signal", "NOT_A_SIGNAL", "worker"])).toMatchObject({
    kind: "output",
    status: 2,
  });
});

test("regex subset handles anchors, classes, ranges, dot, escapes and quantifiers without host backtracking", () => {
  const cases: Array<readonly [string, string, boolean]> = [
    ["^wf-[ab]-token$", "wf-a-token", true],
    ["^wf-[^a-c]+$", "wf-xyz", true],
    ["a.*b", "zabz", true],
    ["a+b?", "aa", true],
    ["a+b?", "b", false],
    ["a\\.b", "axb", false],
    ["a\\.b", "a.b", true],
    ["^$", "", true],
    ["\\$", "cost$", true],
    ["^a?$", "", true],
    ["^a+$", "", false],
  ];
  for (const [pattern, text, expected] of cases)
    expect(compilePattern(pattern, false, false).test(text)).toBe(expected);
  expect(compilePattern("a*a*a*a*a*a*a*a*a*a*b", false, false).test("a".repeat(5_000))).toBe(false);
});

test("regex extensions are rejected explicitly instead of acquiring JavaScript meanings", () => {
  for (const pattern of [
    "(a+)+",
    "foo|bar",
    "[[:digit:]]",
    "\\d",
    "(?=x)",
    "a{2}",
    "a".repeat(513),
  ]) {
    expect(plan("pgrep", ["-f", pattern])).toMatchObject({ kind: "unsupported", status: 2 });
  }
});

test("signal normalization preserves values and literal operands after --", () => {
  const subject = [{ pid: 40, parentPid: 1, comm: "worker", args: "/bin/worker -TERM" }];
  expect(plan("pkill", ["-f", "--", "-TERM"], subject)).toEqual({
    kind: "signal",
    signal: 15,
    pids: [40],
  });
  expect(plan("pkill", ["-P", "-1", "worker"], subject)).toMatchObject({
    kind: "output",
    status: 2,
  });
  expect(plan("pkill", ["-f", "-TERM", "absent"], subject)).toEqual({
    kind: "output",
    status: 1,
    stdout: "",
    stderr: "",
  });
});

test("ignore case is ASCII-only rather than JavaScript Unicode case folding", () => {
  expect(compilePattern("k", true, true).test("K")).toBe(true);
  expect(compilePattern("k", true, true).test("K")).toBe(false);
});
