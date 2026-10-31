import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, spyOn } from "bun:test";
import { createRuntime } from "waffle";

import {
  runFamilyAcceptance,
  type Execution,
  type FamilyAcceptanceSession,
} from "../../../tools/family-acceptance.ts";
import { tar } from "../src/index.ts";
import {
  command,
  native,
  nativeIdentity,
  text,
  withFixtures,
  type ArchiveCase,
  type FixtureSet,
  type Observation,
} from "./fixtures.ts";

const empty = (name: string) => ({ name, programs: [] });
async function execute(
  session: FamilyAcceptanceSession,
  fixture: ArchiveCase,
  path = "/usr/bin/tar",
) {
  const input = session.filledPipe(fixture.input ?? new Uint8Array());
  try {
    return await session.exec({
      executable: path,
      argv: ["tar"].concat(fixture.args),
      cwd: "/owned-tar",
      env: {
        PATH: "/usr/bin:/bin",
        PWD: "/deliberately-wrong",
        TZ: "UTC",
        LC_ALL: "C",
        LANG: "C",
        NO_COLOR: "1",
      },
      fds: [
        { child: 0, parent: input },
        { child: 1, parent: 1 },
        { child: 2, parent: 2 },
      ],
    });
  } finally {
    session.descriptors.close(input);
  }
}
function compare(result: Execution, expected: Observation, name: string, fixtureRoot: string) {
  assert.equal(result.exit.kind, "exited", JSON.stringify(result.exit));
  assert.equal(result.exit.code, expected.status, `${name}: ${text(result.stderr)}`);
  assert.deepEqual(result.stdout, new Uint8Array(expected.stdout), `${name}: stdout`);
  // Native syntax includes writing; the read-only guest advertises only listing.
  // Normalize that exact usage text and the run-owned fixture prefix, not other diagnostics.
  assert.equal(
    text(result.stderr).replaceAll("/owned-tar/", "<fixture>/"),
    text(expected.stderr)
      .replaceAll(fixtureRoot + "/", "<fixture>/")
      .replace(
        "Usage: tar key [FILE...]\n              tar {-c|-t|-x} [-v] -f ARCHIVE [FILE...]",
        "Usage: tar -t [-v] [-z] -f ARCHIVE",
      ),
    `${name}: stderr`,
  );
}
async function seed(session: FamilyAcceptanceSession, fixtures: FixtureSet) {
  await session.filesystem.mkdirp("/owned-tar/source");
  await session.filesystem.writeFile("/unrelated-sentinel", "untouched");
  for (const name of ["fixture.tar", "fixture.tar.gz", "corrupt.tar.gz", "invalid.tar"])
    await session.filesystem.writeFile(
      `/owned-tar/${name}`,
      readFileSync(resolve(fixtures.directory, name)),
    );
}
async function prove(session: FamilyAcceptanceSession, fixtures: FixtureSet) {
  await seed(session, fixtures);
  const help = await execute(session, { name: "truthful WASI help", args: ["--help"] });
  assert.equal(help.exit.kind === "exited" && help.exit.code, 0);
  const helpText = text(help.stdout);
  assert.match(helpText, /Read-only archive listing/);
  assert.match(helpText, /Unsupported on WASI/);
  assert.match(helpText, /ownership and permission/);
  assert.match(helpText, /zstd is unsupported/);
  assert.doesNotMatch(
    helpText,
    /Create a new archive|Extract files from archive|Filter through zstd/,
  );
  for (const fixture of fixtures.cases) {
    const expected = command(native, fixture.args, fixtures.directory, fixture.input);
    const result = await execute(session, fixture);
    compare(result, expected, fixture.name, fixtures.directory);
  }
  const first = fixtures.cases[0];
  assert.ok(first);
  const alias = await execute(session, first, "/bin/tar");
  assert.equal(text(alias.stdout), fixtures.expectedList);
  for (const args of [
    ["-cf", "must-not-exist.tar", "source"],
    ["-xf", "fixture.tar", "-C", "source"],
    ["-xzf", "fixture.tar.gz", "-C", "source"],
  ]) {
    const result = await execute(session, { name: "metadata capability rejection", args });
    assert.equal(result.exit.kind === "exited" && result.exit.code, 2);
    assert.match(text(result.stderr), /create\/extract unavailable: WASI has no UID\/GID/);
    assert.equal(result.stdout.length, 0);
  }
  assert.equal(await session.filesystem.lookup("/owned-tar/must-not-exist.tar"), undefined);
  assert.equal(await session.filesystem.lookup("/owned-tar/source/alpha.txt"), undefined);
  const sentinel = await session.filesystem.readFile("/unrelated-sentinel");
  assert.ok(sentinel);
  assert.equal(text(sentinel), "untouched");
  const archive = process.env.TAR_PACKAGE_ARCHIVE;
  assert.ok(archive, "TAR_PACKAGE_ARCHIVE must be the actual admitted tarball");
  await session.filesystem.writeFile("/owned-tar/package.tgz", readFileSync(archive));
  const packed = await execute(session, {
    name: "actual admitted package archive",
    args: ["-ztf", "package.tgz"],
  });
  const oracle = command(native, ["-ztf", archive], fixtures.directory);
  compare(packed, oracle, "package archive readback", fixtures.directory);
  assert.match(text(packed.stdout), /^package\/dist\/tar\.wasm$/m);
  assert.match(text(packed.stdout), /^package\/dist\/THIRD_PARTY_NOTICES\.txt$/m);
  assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2]);
}

test("real upstream tar loads once on demand for both aliases and runs file/pipe readback", async () => {
  const identity = nativeIdentity();
  console.log(JSON.stringify(identity));
  assert.deepEqual(tar.pick("tar").programs, tar.pick("/bin/tar").programs);
  assert.equal(tar.pick("tar").programs[0], tar.programs[0]);
  const definition = tar.programs[0];
  assert.ok(definition?.wasm);
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  const trackedFetch = Object.assign(
    (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const url = input instanceof Request ? input.url : String(input);
      if (url === definition.wasm?.href) downloads++;
      return originalFetch(...args);
    },
    { preconnect: originalFetch.preconnect },
  );
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(trackedFetch);
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [tar.pick("tar")] },
  });
  try {
    await runtime.programs.ready;
    assert.equal(downloads, 0);
    assert.equal(runtime.programs.get("tar"), runtime.programs.get("/bin/tar"));
    assert.equal(runtime.programs.get("tar")?.state.kind, "registered");
    await withFixtures(async (fixtures) => {
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
          {
            name: "tar actual guest native comparisons and honest metadata failures",
            family: "coreutils",
            run: (session) => prove(session, fixtures),
          },
        ],
      });
    });
    assert.equal(downloads, 1);
    assert.equal(runtime.programs.get("tar")?.state.kind, "loaded");
    const handle = runtime.programs.get("tar");
    assert.ok(handle);
    await handle.remove();
    assert.equal(handle.state.kind, "removed");
    assert.equal(await runtime.filesystem.lookup("/usr/bin/tar"), undefined);
    assert.equal(await runtime.filesystem.lookup("/bin/tar"), undefined);
  } finally {
    try {
      await runtime.dispose();
    } finally {
      fetchSpy.mockRestore();
    }
  }
}, 120_000);
