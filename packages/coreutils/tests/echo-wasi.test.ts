import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import { installPrograms, type ProgramPackage } from "waffle/programs";
import { coreutils } from "../src/index.ts";
import { basePackages, basePrograms } from "../../base/src/index.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
  type Execution,
} from "../../../tools/family-acceptance.ts";
import { verifyXargsArtifact } from "../../findutils/scripts/xargs-artifact.ts";

const decoder = new TextDecoder();
const echo = coreutils.programs.find((program) => program.path === "/usr/bin/echo");
assert.ok(echo, "real echo missing from coreutils descriptor");

function request(session: FamilyAcceptanceSession, argv: string[], input = ""): LaunchRequest {
  const command = argv[0];
  assert.ok(command);
  return {
    executable: `/usr/bin/${command}`,
    argv,
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", PWD: "/" },
    fds: [
      { child: 0, parent: session.filledPipe(input) },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
}

async function execute(session: FamilyAcceptanceSession, argv: string[], input = "") {
  const launched = request(session, argv, input);
  try {
    return await session.exec(launched);
  } finally {
    session.descriptors.close(launched.fds[0]!.parent);
  }
}

function output(result: Execution, status: number, expected: string | Uint8Array) {
  assert.equal(result.exit.status, status, JSON.stringify(result.exit));
  const bytes = typeof expected === "string" ? new TextEncoder().encode(expected) : expected;
  assert.deepEqual(result.stdout, bytes);
  assert.equal(result.stderr.length === 0, status === 0, decoder.decode(result.stderr));
}

async function direct(session: FamilyAcceptanceSession) {
  const cases: Array<[string[], string | Uint8Array]> = [
    [["echo"], "\n"],
    [["echo", "one", "two words", ""], "one two words \n"],
    [["echo", "-n", "X"], "X"],
    [["echo", "-e", "a\\nb\\tend"], "a\nb\tend\n"],
    [
      ["echo", "-e", "\\0\\001\\0177\\0377\\x00\\x41\\xFF"],
      Uint8Array.from([0, 1, 127, 255, 0, 65, 255, 10]),
    ],
    [["echo", "-e", "before\\cafter", "ignored"], "before"],
    [["echo", "-e", "-E", "a\\nb"], "a\\nb\n"],
    [["echo", "--", "X"], "-- X\n"],
    [["echo", "שלום", "🌍", "é"], "שלום 🌍 é\n"],
  ];
  for (const [argv, expected] of cases) output(await execute(session, argv), 0, expected);
  const closedCases: Array<[string[], number]> = [
    [[], 1],
    [["-n"], 0],
    [["-n", ""], 0],
    [["-n", "x"], 1],
    [["-e", "\\c"], 0],
    [["-e", "prefix\\c"], 1],
  ];
  for (const [args, status] of closedCases) {
    const closed = request(session, ["echo"].concat(args));
    closed.fds.splice(1, 1);
    try {
      output(await session.exec(closed), status, "");
    } finally {
      session.descriptors.close(closed.fds[0]!.parent);
    }
  }
}

async function paired(session: FamilyAcceptanceSession) {
  const live = await execute(session, ["xargs", "echo"], "X\n");
  output(live, 0, "X\n");
  const child = live.launches[1];
  // This echo uses the public generic launcher below. Its request is separately
  // observed there; the shared session records only its own xargs launch.
  assert.equal(child, undefined);
  output(await execute(session, ["xargs", "-n1", "echo"], "a b c"), 0, "a\nb\nc\n");
  output(
    await execute(
      session,
      ["xargs", "-0", "-n2", "echo", "fixed space"],
      "a b\0'quoted'\0c\\d\0\0",
    ),
    0,
    "fixed space a b 'quoted'\nfixed space c\\d \n",
  );
  output(await execute(session, ["xargs", "-r", "echo"], " \t\n"), 0, "");
}

async function cancellation(session: FamilyAcceptanceSession) {
  session.resetOutput();
  const [reader, writer] = session.pipe();
  const stdin = session.descriptors.open(reader, (1n << 1n) | (1n << 21n) | (1n << 27n), 0n);
  const launched = request(session, ["xargs", "-n1", "echo"]);
  session.descriptors.close(launched.fds[0]!.parent);
  launched.fds[0] = { child: 0, parent: stdin };
  assert.equal(writer.write([new TextEncoder().encode("X\nY\n")]), 4);
  const running = await session.spawn(launched);
  let complete = false;
  try {
    await session.waitForOutput("X\n");
    running.interrupt();
    assert.equal((await running.exit).status, 130);
    complete = true;
  } finally {
    if (!complete) {
      running.interrupt();
      await running.exit;
    }
    writer.close();
    session.descriptors.close(stdin);
  }
}

function xargsBytes(): Uint8Array {
  const artifact = process.env.ECHO_XARGS_ARTIFACT;
  if (artifact) return verifyXargsArtifact(artifact).bytes;
  // Explicit local development proof against the retained PR194 candidate;
  // this path cannot run in hosted CI or create a source-promotion receipt.
  assert.notEqual(process.env.GITHUB_ACTIONS, "true", "same-run xargs artifact is required");
  assert.ok(process.env.ECHO_LOCAL_XARGS_WASM && process.env.ECHO_LOCAL_XARGS_RECEIPT);
  const identity = JSON.parse(readFileSync(process.env.ECHO_LOCAL_XARGS_RECEIPT, "utf8"));
  const bytes = readFileSync(process.env.ECHO_LOCAL_XARGS_WASM);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), identity.guest.sha256);
  assert.equal(identity.published, false);
  return bytes;
}

async function installEcho(
  session: FamilyAcceptanceSession,
  launches: Array<{ argv: string[]; executable: string }>,
) {
  assert.ok(echo);
  return installPrograms(session.runtime, [{ name: coreutils.name, programs: [echo] }], {
    launcher(context, service) {
      launches.push({ argv: context.request.argv.slice(), executable: context.request.executable });
      return service.launchWorker(context, {
        workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url).href,
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
        },
      });
    },
  });
}

async function proveGap(session: FamilyAcceptanceSession) {
  output(await execute(session, ["xargs", "echo"], "X\n"), 127, "");
  const echoLaunches: Array<{ argv: string[]; executable: string }> = [];
  const installed = await installEcho(session, echoLaunches);
  try {
    assert.deepEqual(installed.executables, ["/usr/bin/echo", "/bin/echo"]);
    assert.equal(echoLaunches.length, 0, "echo installation launched eagerly");
    await direct(session);
    await paired(session);
    assert.ok(
      echoLaunches.some(
        (launch) =>
          JSON.stringify(launch.argv) ===
          JSON.stringify(["echo", "fixed space", "a b", "'quoted'"]),
      ),
    );
    await cancellation(session);
    const supervisor = await (await session.runtime.processes()).ready();
    assert.ok(
      Array.from(supervisor.table.values()).every((record) => record.request === null),
      "child processes survived",
    );
    assert.equal(
      Array.from(supervisor.table.jobValues()).filter((job) => job.jobLifetime === "caller-fatal")
        .length,
      0,
    );
    assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2]);
    assert.ok(echoLaunches.length > 0);
    assert.ok(echoLaunches.every((launch) => launch.executable === "/usr/bin/echo"));
  } finally {
    await installed.dispose();
  }
}

test("real registered echo closes the xargs gap and cleans up a canceled pipeline", async () => {
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  const bytes = xargsBytes();
  const xargs: ProgramPackage = {
    name: "actual-xargs",
    programs: [{ path: "/usr/bin/xargs", source: async () => bytes }],
  };
  const empty: ProgramPackage = { name: "empty", programs: [] };
  try {
    assert.equal(basePrograms.length, 24);
    assert.ok(basePackages.includes(coreutils));
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: {
        coreutils: {
          ...coreutils,
          programs: coreutils.programs.filter((program) => program.path !== "/usr/bin/echo"),
        },
        findutils: xargs,
        grep: empty,
        sed: empty,
        ripgrep: empty,
      },
      cases: [
        {
          name: "before missing127, after real external echo0, argv and canceled pipeline cleanup",
          family: "coreutils",
          run: proveGap,
        },
      ],
    });
  } finally {
    await runtime.dispose();
  }
  assert.equal(runtime.disposed, true);
}, 90_000);
