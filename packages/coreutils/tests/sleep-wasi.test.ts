import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import type { ProgramPackage } from "waffle/programs";
import { coreutils } from "../src/index.ts";
import { sleepCases } from "../fixtures/sleep-cases.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
} from "../../../tools/family-acceptance.ts";

function request(args: string[], executable = "/usr/bin/sleep"): LaunchRequest {
  return {
    executable,
    argv: ["sleep"].concat(args),
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", PWD: "/", LC_ALL: "C", LANG: "C" },
    fds: [0, 1, 2].map((fd) => ({ child: fd, parent: fd })),
  };
}

async function boundedExit(running: Awaited<ReturnType<FamilyAcceptanceSession["spawn"]>>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      running.exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sleep exit deadline exceeded")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancellation(session: FamilyAcceptanceSession, duration: string) {
  const running = await session.spawn(request([duration], "/bin/sleep"));
  let exited = false;
  void running.exit.then(() => {
    exited = true;
  });
  const timer = setTimeout(() => {
    if (!exited) running.interrupt();
  }, 150);
  try {
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(exited, false, "long sleep returned before interruption");
    const exit = await boundedExit(running);
    assert.equal(exit.status, 130, JSON.stringify(exit));
  } finally {
    clearTimeout(timer);
    if (!exited) running.interrupt();
    await running.exit;
  }
}

async function selectedSleep(session: FamilyAcceptanceSession, fetches: string[]) {
  const runtime = session.runtime;
  const handle = runtime.programs.get("sleep");
  assert.ok(handle);
  assert.deepEqual(
    runtime.programs.status().map((entry) => entry.name),
    ["sleep"],
  );
  assert.equal(runtime.programs.get("/bin/sleep"), handle);
  assert.equal(handle.state.kind, "registered");
  assert.equal(fetches.length, 0, "registration eagerly fetched sleep");
  assert.equal(await runtime.filesystem.lookup("/usr/bin/date"), undefined);
  const first = await session.exec(request(["0"], "/bin/sleep"));
  assert.equal(first.exit.status, 0);
  assert.equal(first.stdout.length, 0);
  assert.equal(first.stderr.length, 0);
  assert.equal(handle.state.kind, "loaded");
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0]?.endsWith("/sleep.wasm"));
  for (const fixture of sleepCases) {
    const result = await session.exec(request(fixture.args));
    assert.equal(result.exit.status, fixture.status, fixture.name);
    if (fixture.kind === "metadata") continue;
    assert.equal(result.stdout.length, 0, fixture.name);
    assert.equal(result.stderr.length > 0, fixture.kind === "error", fixture.name);
  }
  // A broad lower bound detects an immediate-return stub without scoring host speed.
  const before = performance.now();
  const waited = await session.exec(request(["0.05", "0.05s", "0.001m"]));
  const elapsed = performance.now() - before;
  assert.equal(waited.exit.status, 0);
  assert.ok(elapsed >= 140, `summed 160 ms wait returned in ${elapsed} ms`);
  await cancellation(session, "30");
  await cancellation(session, "inf");
  const after = await session.exec(request(["0"]));
  assert.equal(after.exit.status, 0, "interruption poisoned the next launch");
  assert.equal(fetches.length, 1, "aliases reloaded sleep");
  const supervisor = await (await runtime.processes()).ready();
  assert.ok(
    Array.from(supervisor.table.values()).every((entry) => entry.request === null),
    "sleep left a live child",
  );
  assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2]);
  await handle.remove();
  assert.equal(handle.state.kind, "removed");
  assert.equal(runtime.programs.get("sleep"), undefined);
  assert.equal(await runtime.filesystem.lookup("/usr/bin/sleep"), undefined);
  assert.equal(await runtime.filesystem.lookup("/bin/sleep"), undefined);
  console.log(
    JSON.stringify({
      scope: "Waffle runtime acceptance",
      fixtureCases: sleepCases.length,
      summedWaitMilliseconds: elapsed,
      cancellations: 2,
      sourceFetches: fetches.length,
      liveChildren: Array.from(supervisor.table.values()).filter((entry) => entry.request !== null)
        .length,
      inheritedDescriptors: session.descriptors.inheritable(),
      removedPaths: ["/usr/bin/sleep", "/bin/sleep"],
    }),
  );
}

test("real sleep guest waits, cancels, shares one lazy source, and removes both paths", async () => {
  const selection = coreutils.pick("sleep", "/bin/sleep");
  assert.equal(selection.programs.length, 1);
  assert.equal(
    selection.programs[0],
    coreutils.programs.find((program) => program.path === "/usr/bin/sleep"),
  );
  const fetches: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = new Proxy(original, {
    apply(target, receiver, args) {
      fetches.push(String(args[0]));
      return Reflect.apply(target, receiver, args);
    },
  });
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [selection] },
  });
  const empty: ProgramPackage = { name: "empty-sleep-session", programs: [] };
  try {
    await runtime.programs.ready;
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: { coreutils: empty, findutils: empty, grep: empty, sed: empty, ripgrep: empty },
      cases: [
        {
          name: "selected sleep",
          family: "coreutils",
          run: (session) => selectedSleep(session, fetches),
        },
      ],
    });
  } finally {
    await runtime.dispose();
    globalThis.fetch = original;
  }
  assert.equal(runtime.disposed, true);
}, 60_000);
