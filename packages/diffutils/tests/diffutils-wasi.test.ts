import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import { basePackages } from "../../base/src/index.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
} from "../../../tools/family-acceptance.ts";
import { diffutils } from "../src/index.ts";
import { diffutilsCases, fixtureFiles, type DiffutilsCase } from "./cases.ts";
import { readOracle } from "./oracle.ts";

const decoder = new TextDecoder();
const empty = (name: string) => ({ name, programs: [] });

function request(session: FamilyAcceptanceSession, fixture: DiffutilsCase): LaunchRequest {
  const program: string = fixture.program;
  return {
    executable: `/usr/bin/${fixture.program}`,
    argv: [program].concat(fixture.args),
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", PWD: "/", LC_ALL: "C", TZ: "UTC" },
    fds: [
      { child: 0, parent: session.filledPipe(fixture.stdin ?? "") },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
}

async function execute(session: FamilyAcceptanceSession, fixture: DiffutilsCase) {
  const launched = request(session, fixture);
  try {
    return await session.exec(launched);
  } finally {
    session.descriptors.close(launched.fds[0]!.parent);
  }
}

function comparable(text: string, fixture: DiffutilsCase) {
  const lines = text.split("\n");
  return lines.slice(fixture.ignoreHeaderLines ?? 0).join("\n");
}

async function seedFixtures(session: FamilyAcceptanceSession) {
  for (const [path, contents] of Object.entries(fixtureFiles)) {
    const destination = `/${path}`;
    const parent = destination.slice(0, destination.lastIndexOf("/"));
    await session.filesystem.mkdirp(parent || "/");
    await session.filesystem.writeFile(destination, contents);
  }
}

async function proveDiffutils(session: FamilyAcceptanceSession) {
  const oracle = readOracle();
  await seedFixtures(session);
  for (const fixture of diffutilsCases) {
    const expected = oracle.cases[fixture.name];
    assert.ok(expected, fixture.name);
    const result = await execute(session, fixture);
    const stderr = decoder.decode(result.stderr);
    assert.equal(result.exit.kind === "exited" && result.exit.code, expected.exit, fixture.name);
    assert.equal(
      comparable(decoder.decode(result.stdout), fixture),
      comparable(expected.stdout, fixture),
      `${fixture.name}: stdout`,
    );
    assert.equal(comparable(stderr, fixture), comparable(expected.stderr, fixture), fixture.name);
  }
}

test("optional GNU diffutils catalog loads lazily and runs through Waffle", async () => {
  assert.ok(basePackages.every((pkg) => pkg.name !== diffutils.name));
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [diffutils] },
  });
  try {
    await runtime.programs.ready;
    assert.equal(runtime.programs.get("diff")?.state.kind, "registered");
    assert.equal(runtime.programs.get("cmp")?.state.kind, "registered");
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
        { name: "real GNU diffutils through onDemand", family: "coreutils", run: proveDiffutils },
      ],
    });
    assert.equal(runtime.programs.get("diff")?.state.kind, "loaded");
    assert.equal(runtime.programs.get("cmp")?.state.kind, "loaded");
  } finally {
    await runtime.dispose();
  }
}, 120_000);
