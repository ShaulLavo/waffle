import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import type { ProgramPackage } from "waffle/programs";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceCase,
  type FamilyAcceptanceSession,
  type Execution,
  type LaunchRequest,
} from "../../../tools/family-acceptance.ts";
import { verifyWasiGuest, wasiBuildConfiguration } from "../../../tools/program-build-tools.ts";

const root = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(root, "packages/findutils");
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const environment = {
  PATH: "/test:/usr/bin",
  PWD: "/deliberately-wrong",
  XARGS_TEST_ENV: "space ' quote \" =",
};

function launch(session: FamilyAcceptanceSession, args: string[], input: string): LaunchRequest {
  return {
    executable: "/usr/bin/xargs",
    argv: ["xargs"].concat(args),
    cwd: "/work",
    env: environment,
    fds: [
      { child: 0, parent: session.filledPipe(input) },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
}

async function execute(session: FamilyAcceptanceSession, args: string[], input = "") {
  const request = launch(session, args, input);
  try {
    return await session.exec(request);
  } finally {
    const stdin = request.fds.find((binding) => binding.child === 0);
    assert.ok(stdin);
    session.descriptors.close(stdin.parent);
  }
}

function expect(result: Execution, status: number, output: string) {
  assert.equal(result.exit.kind, "exited", JSON.stringify(result.exit));
  assert.equal(result.exit.code, status);
  assert.equal(decoder.decode(result.stdout), output);
  assert.equal(
    result.stderr.length === 0,
    status === 0 || status === 123,
    decoder.decode(result.stderr),
  );
}

async function argvCases(session: FamilyAcceptanceSession) {
  await session.filesystem.mkdirp("/work");
  const cases: Array<{ args: string[]; input: string; output: string }> = [
    {
      args: ["child", "dump", "fixed space", "'literal'"],
      input: "'two words' a\\ b \"c d\"\n",
      output: "CALL\0fixed space\0'literal'\0two words\0a b\0c d\0",
    },
    {
      args: ["-0", "-n2", "child", "dump"],
      input: "a b\0'quoted'\0c\\d\0\0",
      output: "CALL\0a b\0'quoted'\0CALL\0c\\d\0\0",
    },
    { args: ["-s15", "child", "dump"], input: "a b c", output: "CALL\0a\0b\0CALL\0c\0" },
    { args: ["-n1", "child", "dump"], input: "a b c\n", output: "CALL\0a\0CALL\0b\0CALL\0c\0" },
    { args: ["-L1", "child", "dump"], input: "a b\nc d\n", output: "CALL\0a\0b\0CALL\0c\0d\0" },
    { args: ["-d:", "-n2", "child", "dump"], input: "a b:c:d", output: "CALL\0a b\0c\0CALL\0d\0" },
    { args: ["./child", "dump"], input: "x\n", output: "CALL\0x\0" },
    { args: ["/test/child", "dump"], input: "x\n", output: "CALL\0x\0" },
    { args: ["child", "dump"], input: "", output: "CALL\0" },
    { args: ["-r", "child", "dump"], input: " \t\n", output: "" },
    { args: ["-r", "missing"], input: "", output: "" },
    { args: ["child", "stdin"], input: "ignored\n", output: "" },
    { args: [], input: "one two\nthree\n", output: "one two three\n" },
  ];
  for (const item of cases) expect(await execute(session, item.args, item.input), 0, item.output);
  const context = await execute(session, ["child", "context"], "x");
  expect(context, 0, `/work\n${environment.XARGS_TEST_ENV}\n`);
  const child = context.launches[1];
  assert.ok(child);
  assert.deepEqual(child.argv, ["child", "context", "x"]);
  assert.deepEqual(child.env, environment);
  assert.equal(child.cwd, "/work");
  assert.deepEqual(child.fds, [0, 1, 2]);
}

async function outcomes(session: FamilyAcceptanceSession) {
  for (const status of [0, 1, 7, 126, 127, 255]) {
    const result = await execute(session, ["child", "status", String(status)], "x");
    expect(result, status === 0 ? 0 : status === 255 ? 124 : 123, "");
  }
  expect(await execute(session, ["-n1", "child", "sequence"], "1 0"), 123, "1\n0\n");
  expect(await execute(session, ["-n1", "child", "sequence"], "255 0"), 124, "255\n");
  expect(await execute(session, ["child", "signal", "15"], "x"), 125, "");
  await session.filesystem.writeFile("/work/plain", "not executable");
  for (const program of ["missing", "echo", "/test/missing"])
    expect(await execute(session, [program], "x"), 127, "");
  for (const program of ["/work/plain", "/work", "/test/broken"])
    expect(await execute(session, [program], "x"), 126, "");
  for (const args of [
    ["-P1", "child"],
    ["-P2", "child"],
    ["-P0", "child"],
    ["--max-procs=1", "child"],
    ["-I{}", "child", "{}"],
    ["--replace", "child", "{}"],
  ]) {
    const result = await execute(session, args);
    expect(result, 1, "");
    assert.equal(result.launches.length, 1, "unsupported mode launched a child");
  }
}

async function descriptors(session: FamilyAcceptanceSession) {
  await session.filesystem.writeFile("/work/input", "ignored\n");
  expect(
    await execute(session, ["-a", "input", "child", "stdin"], "child stdin\n"),
    0,
    "child stdin\n",
  );
  const request = launch(session, ["child", "fd7"], "ignored\n");
  const seven = session.filledPipe("sparse descriptor\n");
  request.fds.push({ child: 7, parent: seven }, { child: 4095, parent: 1 });
  try {
    const result = await session.exec(request);
    expect(result, 0, "sparse descriptor\n");
    assert.deepEqual(result.launches[1]?.fds, [0, 1, 2, 7, 4095]);
  } finally {
    session.descriptors.close(seven);
    const input = request.fds[0];
    assert.ok(input);
    session.descriptors.close(input.parent);
  }
}

async function cancellation(session: FamilyAcceptanceSession) {
  session.resetOutput();
  const request = launch(session, ["child", "spin"], "x");
  const running = await session.spawn(request);
  let finished = false;
  try {
    await session.waitForOutput("READY\n");
    running.interrupt();
    const result = await running.exit;
    finished = true;
    assert.equal(result.kind, "signaled", JSON.stringify(result));
    assert.equal(result.status, 130, JSON.stringify(result));
    const supervisor = await (await session.runtime.processes()).ready();
    const records = Array.from(supervisor.table.values());
    assert.equal(
      records.length,
      1,
      `children survived cancellation: ${records.map((record) => record.pid)}`,
    );
    assert.equal(
      Array.from(supervisor.table.jobValues()).filter((job) => job.jobLifetime === "caller-fatal")
        .length,
      0,
      "xargs-owned jobs survived cancellation",
    );
  } finally {
    if (!finished) {
      running.interrupt();
      await running.exit;
    }
    const stdin = request.fds[0];
    assert.ok(stdin);
    session.descriptors.close(stdin.parent);
  }
}

async function cleanup(session: FamilyAcceptanceSession) {
  const supervisor = await (await session.runtime.processes()).ready();
  assert.equal(
    Array.from(supervisor.table.values()).length,
    1,
    "child process records survived wait",
  );
  const jobs = Array.from(supervisor.table.jobValues());
  assert.equal(
    jobs.filter((job) => job.jobLifetime === "caller-fatal").length,
    0,
    "xargs-owned jobs survived wait",
  );
  // The shared session collects PIDs; its independent launch-job metadata belongs
  // to the test controller and is removed when the runtime is disposed.
  assert.ok(jobs.every((job) => job.pendingMembers === 0 || job.members.size === 1));
  assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2], "parent descriptors leaked");
}

const cases: readonly FamilyAcceptanceCase[] = [
  {
    name: "explicit argv, grouping, empty input and runtime cwd/environment",
    family: "findutils",
    run: argvCases,
  },
  { name: "GNU child outcomes and honest executable lookup", family: "findutils", run: outcomes },
  {
    name: "argument-file stdin and sparse inherited descriptors",
    family: "findutils",
    run: descriptors,
  },
  {
    name: "caller cancellation retires child workers and jobs",
    family: "findutils",
    run: cancellation,
  },
  {
    name: "consuming waits leave no child records, jobs or descriptors",
    family: "findutils",
    run: cleanup,
  },
];

test("actual xargs WASI executes through the singular generic runtime and retires children", async () => {
  const scratch = mkdtempSync(resolve(root, ".build/xargs-process-"));
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  try {
    const config = wasiBuildConfiguration({ root, waffle: resolve(root, "packages/waffle") });
    const fixture = resolve(scratch, "child.wasm");
    execFileSync(config.linker, [
      "--target=wasm32-wasip1",
      `--sysroot=${config.sysroot}`,
      "-Wl,--max-memory=268435456",
      resolve(packageRoot, "tests/fixtures/xargs-child.c"),
      "-o",
      fixture,
    ]);
    verifyWasiGuest(fixture);
    const xargs = readFileSync(resolve(root, ".build/findutils/wasm32-wasip1/release/xargs.wasm"));
    const child = readFileSync(fixture);
    const empty: ProgramPackage = { name: "empty", programs: [] };
    const findutils: ProgramPackage = {
      name: "xargs-controlled-tests",
      programs: [
        { path: "/usr/bin/xargs", source: async () => xargs },
        { path: "/test/child", aliases: ["/work/child"], source: async () => child },
        { path: "/test/broken", source: async () => encoder.encode("invalid Wasm") },
      ],
    };
    const completed = await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: { findutils, coreutils: empty, grep: empty, sed: empty, ripgrep: empty },
      cases,
    });
    assert.equal(completed.length, cases.length);
  } finally {
    await runtime.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(runtime.disposed, true);
}, 90_000);
