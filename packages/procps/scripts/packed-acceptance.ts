import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createRuntime } from "../../waffle/runtime.ts";
import { defineProgramPackage } from "../../waffle/programs/catalog.ts";
import { commandShell } from "../../waffle/tests/program-host-command-fixture.ts";

const consumer = process.argv[2];
if (!consumer) throw new Error("Expected an extracted package consumer path");
const entry = createRequire(consumer).resolve("waffle-procps/programs");
assert.equal(entry, join(dirname(consumer), "package", "src", "catalog.ts"));
const { procps }: typeof import("../src/catalog.ts") = await import(entry);
const runtime = createRuntime({
  sharedMemory: testSharedMemory,
  filesystem: {
    mode: "memory",
    workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
  },
});
const cleanup: Array<() => void | Promise<void>> = [];
try {
  await runtime.programs.onDemand(procps);
  assert.deepEqual(runtime.programs.get("ps")!.state, { kind: "registered" });
  const shell = await commandShell(runtime, cleanup, { signalDelegation: { packages: [procps] } });
  await shell.file(1, "/out");
  await shell.file(2, "/err");
  await runtime.programs.onDemand(
    defineProgramPackage({
      name: "packed-fixture",
      programs: [
        {
          path: "/packed-fixture",
          command: {
            load:
              async () =>
              async ({ abort }) => {
                await new Promise<void>((resolve) => {
                  if (abort.aborted) resolve();
                  else abort.addEventListener("abort", () => resolve(), { once: true });
                });
                return 0;
              },
          },
        },
      ],
    }),
  );
  const target = await shell.spawn("/packed-fixture", ["fixture", "archive-owned"]);
  const stdio = [
    { parent: 1, child: 1 },
    { parent: 2, child: 2 },
  ];
  for (const [name, argv, expected] of [
    ["ps", ["ps", "-p", String(target.pid), "-o", "args="], "fixture archive-owned\n"],
    ["pgrep", ["pgrep", "-x", "packed-fixture"], `${target.pid}\n`],
    ["pkill", ["pkill", "-TERM", "-x", "packed-fixture"], ""],
  ] satisfies Array<[string, string[], string]>) {
    shell.descriptors.close(1);
    await shell.file(1, "/out");
    const child = await shell.spawn(`/bin/${name}`, argv, stdio);
    assert.equal((await child.collect()).code, 0);
    assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("/out")), expected);
  }
  assert.deepEqual(await target.collect(), { kind: "signaled", code: 15, status: 143 });
  assert.equal(new TextDecoder().decode(await runtime.filesystem.readFile("/err")), "");
  for (const name of ["ps", "pgrep", "pkill"]) await runtime.programs.get(name)!.remove();
  const removed = await shell.spawn("/bin/ps");
  assert.equal((await removed.collect()).kind, "start-failed");
  console.log(
    "Extracted packed catalog executed ps, pgrep and granted sibling pkill; removal passed.",
  );
} finally {
  await runtime.dispose();
  for (const close of cleanup.toReversed()) await close();
}
assert.equal(runtime.disposed, true);
