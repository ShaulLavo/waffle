import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { createRuntime, type Runtime } from "waffle";
import { PipeErrno, type PipeEndpoint } from "waffle/proc/pipes";
import type { ProgramPackage } from "waffle/programs";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
  type RunningProgram,
} from "../../../tools/family-acceptance.ts";
import { checksumNames } from "../scripts/programs.ts";
import { coreutils } from "../src/index.ts";
import {
  readFixture,
  streamingInput,
  verifyFixture,
  type ChecksumCase,
  type ChecksumFixture,
} from "../scripts/checksum-oracle.ts";

import { checksumRegressions } from "./helpers/checksum-regressions.ts";

// Defaults to the package's staged guests; set this to read back a retained artifact directory.
const artifactDirectory = process.env.CHECKSUM_ARTIFACTS;
const decoder = new TextDecoder();
const empty: ProgramPackage = { name: "empty", programs: [] };

function guestUrl(name: string, packaged: URL | undefined) {
  if (artifactDirectory) return pathToFileURL(resolve(artifactDirectory, `${name}.wasm`));
  assert.ok(packaged, `coreutils has no packaged guest for ${name}`);
  return packaged;
}

/** The registered coreutils checksum entries, with fetches recorded for lazy-load checks. */
function checksumPackage(loaded: string[]): ProgramPackage {
  const registered = coreutils.pick(...checksumNames);
  return {
    name: "coreutils-checksums",
    programs: checksumNames.map((name, index) => {
      const program = registered.programs[index];
      assert.ok(program && program.path === `/usr/bin/${name}`, name);
      const url = guestUrl(name, program.wasm);
      return {
        path: program.path,
        aliases: program.aliases,
        source: async () => {
          loaded.push(name);
          const response = await fetch(url);
          assert.ok(response.ok, `Cannot fetch checksum artifact: ${name}`);
          return new Uint8Array(await response.arrayBuffer());
        },
      };
    }),
  };
}

function request(args: readonly [string, ...string[]], stdin: number): LaunchRequest {
  return {
    executable: `/usr/bin/${args[0]}`,
    argv: args.slice(),
    cwd: "/work",
    env: { PATH: "/usr/bin:/bin", PWD: "/work", HOME: "/tmp/spec", LC_ALL: "C", TZ: "UTC" },
    fds: [
      { child: 0, parent: stdin },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
}

async function assertFixtureCase(session: FamilyAcceptanceSession, entry: ChecksumCase) {
  for (const file of entry.files) {
    await session.filesystem.writeFile(
      `/work/${file.path}`,
      Buffer.from(file.contentBase64, "base64"),
    );
  }
  const stdin = session.filledPipe(Buffer.from(entry.inputBase64, "base64"));
  try {
    const result = await session.exec(request(entry.args, stdin));
    assert.equal(result.exit.kind, "exited", entry.name);
    assert.equal(result.exit.code, entry.status, `${entry.name}: ${decoder.decode(result.stderr)}`);
    assert.deepEqual(
      result.stdout,
      new Uint8Array(Buffer.from(entry.stdoutBase64, "base64")),
      entry.name,
    );
    assert.equal(result.stderr.length > 0, entry.stderrPresent, `${entry.name}: stderr presence`);
  } finally {
    session.descriptors.close(stdin);
  }
}

async function writeChunk(writer: PipeEndpoint, chunk: Uint8Array) {
  let offset = 0;
  while (offset < chunk.length) {
    const count = writer.tryWrite([chunk.subarray(offset)]);
    if (count === -PipeErrno.AGAIN) {
      await writer.waitWritable();
      continue;
    }
    assert.ok(count > 0, `Checksum stream write failed: ${count}`);
    offset += count;
  }
}

async function streamInput(writer: PipeEndpoint) {
  for (let index = 0; index < streamingInput.repetitions; index++) {
    await writeChunk(writer, streamingInput.chunk);
  }
}

async function assertStreaming(
  session: FamilyAcceptanceSession,
  expected: ChecksumFixture["stream"],
  cancel: boolean,
) {
  session.resetOutput();
  const [reader, writer] = session.pipe();
  const stdin = session.descriptors.open(reader, (1n << 1n) | (1n << 21n) | (1n << 27n), 0n);
  let running: RunningProgram | undefined;
  let exited = false;
  const deadline = setTimeout(() => running?.interrupt(), 10_000);
  try {
    running = await session.spawn(request(["sha256sum"], stdin));
    await streamInput(writer);
    if (cancel) running.interrupt();
    else writer.close();
    const exit = await running.exit;
    exited = true;
    assert.equal(exit.status, cancel ? 130 : expected.status);
    if (!cancel)
      await session.waitForOutput(Buffer.from(expected.stdoutBase64, "base64").toString());
  } finally {
    clearTimeout(deadline);
    writer.close();
    if (running && !exited) {
      running.interrupt();
      await running.exit;
    }
    session.descriptors.close(stdin);
  }
}

async function observations(
  session: FamilyAcceptanceSession,
  fixture: ChecksumFixture,
  loaded: string[],
) {
  await session.filesystem.mkdirp("/work");
  assert.deepEqual(loaded, []);
  const priority = fixture.cases.find((entry) => entry.name === "sha256sum reads stdin");
  assert.ok(priority);
  await assertFixtureCase(session, priority);
  assert.deepEqual(loaded, ["sha256sum"]);
  await assertFixtureCase(session, priority);
  assert.deepEqual(loaded, ["sha256sum"]);
  const handle = session.runtime.programs.get("sha256sum");
  assert.ok(handle);
  assert.equal(handle, session.runtime.programs.get("/bin/sha256sum"));
  assert.equal(handle.state.kind, "loaded");
  for (const entry of fixture.cases) await assertFixtureCase(session, entry);
  console.log(`Passed ${fixture.cases.length} checksum oracle cases`);
  await checksumRegressions(session);
  await assertStreaming(session, fixture.stream, false);
  await assertStreaming(session, fixture.stream, true);
  assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2]);
  const supervisor = await (await session.runtime.processes()).ready();
  assert.ok(Array.from(supervisor.table.values()).every((record) => record.request === null));
}

async function assertRemoved(runtime: Runtime, name: string) {
  assert.equal(runtime.programs.get(name), undefined);
  assert.equal(await runtime.filesystem.lookup(`/usr/bin/${name}`), undefined);
  assert.equal(await runtime.filesystem.lookup(`/bin/${name}`), undefined);
}

test("pinned checksum guests stream through Waffle with lazy fetch and disposal", async () => {
  const fixture = verifyFixture(readFixture());
  const loaded: string[] = [];
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [checksumPackage(loaded)] },
  });
  try {
    await runtime.programs.ready;
    assert.deepEqual(loaded, []);
    assert.ok(runtime.programs.status().every((handle) => handle.state.kind === "registered"));
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: { coreutils: empty, findutils: empty, grep: empty, sed: empty, ripgrep: empty },
      cases: [
        {
          name: "checksum family observations, chunked input and interruption",
          family: "coreutils",
          run: (session) => observations(session, fixture, loaded),
        },
      ],
    });
    assert.deepEqual(new Set(loaded), new Set(checksumNames));
    assert.equal(loaded.length, checksumNames.length);
    const handles = runtime.programs.status();
    await Promise.all(handles.map((handle) => handle.remove()));
    assert.ok(handles.every((handle) => handle.state.kind === "removed"));
    assert.deepEqual(runtime.programs.status(), []);
    for (const name of checksumNames) await assertRemoved(runtime, name);
    await runtime.filesystem.writeFile("/work/after-disposal", "alive");
    assert.equal(
      decoder.decode(await runtime.filesystem.readFile("/work/after-disposal")),
      "alive",
    );
  } finally {
    await runtime.dispose();
  }
  assert.equal(runtime.disposed, true);
}, 60_000);
