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

async function execute(
  session: FamilyAcceptanceSession,
  args: string[],
  input: string | Uint8Array = "",
  executable = "/usr/bin/nl",
) {
  const stdin = session.filledPipe(input);
  try {
    return await session.exec({
      executable,
      argv: ["nl"].concat(args),
      cwd: "/work",
      env: { PATH: "/usr/bin:/bin", PWD: "/work", LC_ALL: "C" },
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

async function selectedNl(session: FamilyAcceptanceSession) {
  const runtime = session.runtime;
  const handle = runtime.programs.get("nl");
  assert.ok(handle);
  assert.deepEqual(
    runtime.programs.status().map((entry) => entry.name),
    ["nl"],
  );
  assert.equal(handle.state.kind, "registered");
  assert.equal(runtime.programs.get("/bin/nl"), handle);
  assert.equal(await runtime.filesystem.lookup("/usr/bin/cat"), undefined);
  await runtime.filesystem.mkdirp("/work");
  await runtime.filesystem.writeFile("/work/input", "source\n\nend");
  const file = await execute(session, ["-ba", "-v42", "input"], "", "/bin/nl");
  assert.equal(file.exit.status, 0);
  assert.equal(new TextDecoder().decode(file.stdout), "    42\tsource\n    43\t\n    44\tend\n");
  assert.equal(file.stderr.length, 0);
  assert.equal(handle.state.kind, "loaded");
  const binary = await execute(
    session,
    ["-ba", "-w1", "-s:"],
    Uint8Array.from([255, 13, 10, 0, 10]),
  );
  assert.equal(binary.exit.status, 0);
  assert.deepEqual(binary.stdout, Uint8Array.from([49, 58, 255, 13, 10, 50, 58, 0, 10]));
  const bre = await execute(session, ["-b", "p^a+$", "-w1", "-s:"], "a+\naa\n");
  assert.equal(bre.exit.status, 0);
  assert.equal(new TextDecoder().decode(bre.stdout), "1:a+\n  aa\n");
  const missing = await execute(session, ["missing"]);
  assert.equal(missing.exit.status, 1);
  assert.equal(missing.stdout.length, 0);
  assert.ok(missing.stderr.length > 0);
  assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2]);
  await handle.remove();
  assert.equal(handle.state.kind, "removed");
  assert.equal(runtime.programs.get("nl"), undefined);
  assert.equal(await runtime.filesystem.lookup("/usr/bin/nl"), undefined);
  assert.equal(await runtime.filesystem.lookup("/bin/nl"), undefined);
}

test("the selectable nl catalog runs real file and stdin guests on one runtime", async () => {
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [coreutils.pick("nl")] },
  });
  const empty: ProgramPackage = { name: "empty-session", programs: [] };
  try {
    await runtime.programs.ready;
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: { coreutils: empty, findutils: empty, grep: empty, sed: empty, ripgrep: empty },
      cases: [{ name: "selected nl", family: "coreutils", run: selectedNl }],
    });
  } finally {
    await runtime.dispose();
  }
  assert.equal(runtime.disposed, true);
}, 60_000);
