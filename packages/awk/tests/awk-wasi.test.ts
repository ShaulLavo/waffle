import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import { createRuntime } from "waffle";
import { basePackages } from "../../base/src/index.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
} from "../../../tools/family-acceptance.ts";
import { awk } from "../src/index.ts";
import { awkCases, unsupportedCases, type AwkCase } from "./awk-cases.ts";
import { readOracle } from "./record-awk-oracle.ts";

const decoder = new TextDecoder();
const empty = (name: string) => ({ name, programs: [] });
const oracle = readOracle();

async function bounded<T>(label: string, pending: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), milliseconds);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function request(
  session: FamilyAcceptanceSession,
  fixture: AwkCase,
  executable = "/usr/bin/awk",
): LaunchRequest {
  return {
    executable,
    argv: ["awk"].concat(fixture.args),
    cwd: fixture.cwd ?? "/awk-work",
    env: {
      PATH: "/usr/bin:/bin",
      PWD: fixture.cwd ?? "/awk-work",
      LC_ALL: "C.UTF-8",
      AWK_FIXTURE: "from-environment",
    },
    fds: [
      { child: 0, parent: session.filledPipe(fixture.stdin ?? "") },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
}

async function execute(session: FamilyAcceptanceSession, fixture: AwkCase, executable?: string) {
  const cwd = fixture.cwd ?? "/awk-work";
  await session.filesystem.mkdirp(cwd);
  for (const [name, contents] of Object.entries(fixture.files ?? {}))
    await session.filesystem.writeFile(`${cwd}/${name}`, contents);
  const launched = request(session, fixture, executable);
  try {
    return await bounded(fixture.name, session.exec(launched));
  } finally {
    session.descriptors.close(launched.fds[0]!.parent);
  }
}

async function proveAwk(session: FamilyAcceptanceSession): Promise<void> {
  const originalFilesystem = session.filesystem;
  const originalProcesses = await session.runtime.processes();
  for (const fixture of awkCases) {
    const expected = oracle[fixture.name];
    assert.ok(expected, fixture.name);
    const result = await execute(session, fixture);
    assert.deepEqual(
      result.exit,
      { kind: "exited", code: expected.exit, status: expected.exit },
      fixture.name,
    );
    assert.equal(decoder.decode(result.stdout), expected.stdout, `${fixture.name}: stdout`);
    assert.equal(decoder.decode(result.stderr), expected.stderr, `${fixture.name}: stderr`);
    for (const [name, contents] of Object.entries(expected.files))
      assert.equal(
        decoder.decode(await session.filesystem.readFile(`${fixture.cwd ?? "/awk-work"}/${name}`)),
        contents,
        name,
      );
  }
  const fixture = awkCases[0]!;
  const alias = await execute(session, fixture, "/bin/awk");
  assert.equal(decoder.decode(alias.stdout), oracle[fixture.name]!.stdout);
  assert.equal(await session.runtime.processes(), originalProcesses);
  assert.equal(session.runtime.filesystem, originalFilesystem);
}

async function proveUnsupported(session: FamilyAcceptanceSession): Promise<void> {
  for (const fixture of unsupportedCases) {
    const result = await execute(session, { name: fixture.name, args: [fixture.program] });
    assert.deepEqual(result.exit, { kind: "exited", code: 2, status: 2 }, fixture.name);
    assert.equal(result.stdout.length, 0, fixture.name);
    assert.ok(decoder.decode(result.stderr).includes(fixture.diagnostic), fixture.name);
  }
}

async function proveStopFence(session: FamilyAcceptanceSession): Promise<void> {
  const fixture = {
    name: "nonterminating awk",
    args: ['BEGIN { print "started"; fflush(); for (;;) {} }'],
  };
  session.resetOutput();
  const launched = request(session, fixture);
  const running = await bounded("spawn infinite awk", session.spawn(launched));
  let stopped = false;
  const exit = running.exit.finally(() => {
    stopped = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopped, false, "infinite awk must be running, not a start-failed reservation");
    await bounded("infinite awk started", session.waitForOutput("started"));
    const handle = session.runtime.programs.get("awk");
    assert.ok(handle);
    let removed = false;
    const removal = handle.remove().then(() => {
      removed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(removed, false, "removal must wait for the running guest's physical stop");
    running.interrupt();
    assert.deepEqual(await bounded("interrupt infinite awk", exit, 5_000), {
      kind: "signaled",
      code: 2,
      status: 130,
    });
    await bounded("remove after physical stop", removal);
    assert.equal(await session.filesystem.lookup("/usr/bin/awk"), undefined);
    assert.equal(await session.filesystem.lookup("/bin/awk"), undefined);
    assert.equal(
      session.runtime.disposed,
      false,
      "program removal does not dispose its borrowed runtime",
    );
    assert.equal(
      decoder.decode(await session.filesystem.readFile("/awk-work/output")),
      "first\nsecond\n",
    );
  } finally {
    if (!stopped) running.interrupt();
    session.descriptors.close(launched.fds[0]!.parent);
  }
}

test("optional awk registration does not fetch and removal preserves caller files", async () => {
  const fetching = spyOn(globalThis, "fetch");
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [awk] },
  });
  try {
    await bounded("metadata registration", runtime.programs.ready);
    const handle = runtime.programs.get("awk");
    assert.ok(handle);
    assert.equal(handle.state.kind, "registered");
    assert.equal(runtime.programs.get("/bin/awk"), handle);
    await runtime.programs.onDemand(awk.pick("/bin/awk"));
    assert.equal(runtime.programs.status().length, 1);
    assert.equal(fetching.mock.calls.length, 0);
    await runtime.filesystem.writeFile("/usr/bin/awk", "caller replacement");
    await bounded("metadata removal", handle.remove());
    assert.equal(
      decoder.decode(await runtime.filesystem.readFile("/usr/bin/awk")),
      "caller replacement",
    );
    assert.equal(await runtime.filesystem.lookup("/bin/awk"), undefined);
    assert.equal(runtime.disposed, false);
    assert.equal(fetching.mock.calls.length, 0);
  } finally {
    await runtime.dispose();
    fetching.mockRestore();
  }
}, 15_000);

test("real optional awk shares one lazy payload, borrows its runtime, and retires physically", async () => {
  assert.ok(basePackages.every((pkg) => pkg.name !== awk.name));
  assert.equal(awk.programs.length, 1);
  assert.deepEqual(awk.programs[0]?.aliases, ["/bin/awk"]);
  assert.equal(awk.pick("awk").programs[0], awk.programs[0]);
  assert.equal(awk.pick("/bin/awk").programs[0], awk.programs[0]);
  assert.equal(
    awk.dispose,
    undefined,
    "plain Wasm owns no filesystem payload or runtime disposal hook",
  );
  assert.throws(() => awk.pick("not-awk"), /Unknown program/);
  const fetching = spyOn(globalThis, "fetch");
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [awk.pick("awk")] },
  });
  const payload = new URL("../dist/awk.wasm", import.meta.url).href;
  const loads = () => fetching.mock.calls.filter((call) => String(call[0]) === payload).length;
  try {
    await bounded("catalog registration", runtime.programs.ready);
    assert.equal(runtime.programs.get("awk")?.state.kind, "registered");
    assert.equal(runtime.programs.get("/bin/awk"), runtime.programs.get("awk"));
    await runtime.programs.onDemand(awk.pick("/bin/awk"));
    assert.equal(runtime.programs.status().length, 1);
    assert.equal(loads(), 0);
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: {
        coreutils: empty("coreutils"),
        findutils: empty("findutils"),
        grep: empty("grep"),
        sed: empty("sed"),
        ripgrep: empty("ripgrep"),
      },
      cases: [
        { name: "native oracle through onDemand", family: "coreutils", run: proveAwk },
        { name: "unsupported host operations fail", family: "coreutils", run: proveUnsupported },
        {
          name: "nontermination and physical disposal fence",
          family: "coreutils",
          run: proveStopFence,
        },
      ],
    });
    assert.equal(loads(), 1, "canonical name and alias share one payload load");
  } finally {
    await runtime.dispose();
    fetching.mockRestore();
  }
  assert.equal(runtime.disposed, true);
}, 90_000);
