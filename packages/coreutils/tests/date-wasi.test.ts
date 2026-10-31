import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import type { ProgramPackage } from "waffle/programs";
import { coreutils } from "../src/index.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
} from "../../../tools/family-acceptance.ts";

const decoder = new TextDecoder();

async function execute(
  session: FamilyAcceptanceSession,
  args: string[],
  executable = "/usr/bin/date",
) {
  const stdin = session.filledPipe("");
  try {
    return await session.exec({
      executable,
      argv: ["date"].concat(args),
      cwd: "/work",
      env: { PATH: "/usr/bin:/bin", PWD: "/work", LC_ALL: "C", LANG: "C", TZ: "UTC0" },
      fds: [
        { child: 0, parent: stdin },
        { child: 1, parent: 1 },
        { child: 2, parent: 2 },
      ],
    });
  } finally {
    session.descriptors.close(stdin);
  }
}

async function selectedDate(session: FamilyAcceptanceSession, fetches: string[]) {
  const runtime = session.runtime;
  const handle = runtime.programs.get("date");
  assert.ok(handle);
  assert.deepEqual(
    runtime.programs.status().map((entry) => entry.name),
    ["date"],
  );
  assert.equal(handle.state.kind, "registered");
  assert.equal(runtime.programs.get("/bin/date"), handle);
  assert.equal(fetches.length, 0, "registration fetched a guest");
  assert.equal(await runtime.filesystem.lookup("/usr/bin/nl"), undefined);
  await runtime.filesystem.mkdirp("/work");
  const first = await execute(session, ["-u", "-d", "@0", "+%s %FT%TZ"], "/bin/date");
  assert.equal(first.exit.status, 0);
  assert.equal(decoder.decode(first.stdout), "0 1970-01-01T00:00:00Z\n");
  assert.equal(first.stderr.length, 0);
  assert.equal(handle.state.kind, "loaded");
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0]?.endsWith("/date.wasm"));
  await verifyFormatting(session);
  await verifyFileTime(session);
  await verifyRealClock(session);
  await verifyFailures(session);
  assert.equal(fetches.length, 1, "aliases reloaded the same date guest");
  assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2]);
  await handle.remove();
  assert.equal(handle.state.kind, "removed");
  assert.equal(runtime.programs.get("date"), undefined);
  assert.equal(await runtime.filesystem.lookup("/usr/bin/date"), undefined);
  assert.equal(await runtime.filesystem.lookup("/bin/date"), undefined);
}

async function verifyFormatting(session: FamilyAcceptanceSession) {
  const iso = await execute(session, ["--utc", "-d", "@1709210096", "--iso-8601=seconds"]);
  assert.equal(iso.exit.status, 0);
  assert.equal(decoder.decode(iso.stdout), "2024-02-29T12:34:56+00:00\n");
  const negative = await execute(session, ["-u", "-d", "@-1.5", "+%s.%N"]);
  assert.equal(negative.exit.status, 0);
  assert.equal(decoder.decode(negative.stdout), "-2.500000000\n");
}

async function verifyFileTime(session: FamilyAcceptanceSession) {
  await session.filesystem.writeFile("/work/reference", "fixture\n");
  const metadata: unknown = await session.filesystem.lookup("/work/reference");
  assert.ok(metadata && typeof metadata === "object" && "mtime" in metadata);
  assert.ok(typeof metadata.mtime === "number");
  const reference = await execute(session, ["-u", "-r", "reference", "+%s"]);
  assert.equal(reference.exit.status, 0);
  assert.equal(decoder.decode(reference.stdout), `${Math.floor(metadata.mtime / 1000)}\n`);
  assert.equal(reference.stderr.length, 0);
}

async function verifyRealClock(session: FamilyAcceptanceSession) {
  const before = Math.floor(Date.now() / 1000);
  const current = await execute(session, ["--utc", "+%s"]);
  const after = Math.floor(Date.now() / 1000);
  assert.equal(current.exit.status, 0);
  assert.match(decoder.decode(current.stdout), /^\d+\n$/);
  const seconds = Number(decoder.decode(current.stdout).trim());
  assert.ok(
    seconds >= before && seconds <= after,
    `real clock ${seconds} outside ${before}..${after}`,
  );
  assert.equal(current.stderr.length, 0);
}

async function verifyFailures(session: FamilyAcceptanceSession) {
  for (const args of [["-d", "not-a-date"], ["-r", "missing"], ["-c"], ["-s", "@0"]]) {
    const failure = await execute(session, args);
    assert.equal(failure.exit.status, 1, args.join(" "));
    assert.equal(failure.stdout.length, 0);
    assert.ok(failure.stderr.length > 0);
  }
}

test("the real date guest is selected lazily, shares aliases, and uses actual time and file metadata", async () => {
  const selection = coreutils.pick("date", "/bin/date");
  assert.equal(selection.programs.length, 1);
  assert.equal(
    selection.programs[0],
    coreutils.programs.find((program) => program.path === "/usr/bin/date"),
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
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [selection] },
  });
  const empty: ProgramPackage = { name: "empty-date-session", programs: [] };
  try {
    await runtime.programs.ready;
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: { coreutils: empty, findutils: empty, grep: empty, sed: empty, ripgrep: empty },
      cases: [
        {
          name: "selected date",
          family: "coreutils",
          run: (session) => selectedDate(session, fetches),
        },
      ],
    });
  } finally {
    await runtime.dispose();
    globalThis.fetch = original;
  }
  assert.equal(runtime.disposed, true);
}, 60_000);
