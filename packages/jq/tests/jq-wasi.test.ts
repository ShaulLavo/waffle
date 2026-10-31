import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import { basePackages } from "../../base/src/index.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
} from "../../../tools/family-acceptance.ts";
import { jq } from "../src/index.ts";
import { jqCases, type JqCase } from "./jq-cases.ts";
import { readOracle } from "./record-jq-oracle.ts";

const decoder = new TextDecoder();
const empty = (name: string) => ({ name, programs: [] });
const selectedNames = new Set([
  "raw top-level string",
  "compact object construction",
  "slurp stream",
  "JSON argument",
  "environment filter",
  "gh complex query",
  "invalid expression",
]);
const selected = jqCases.filter((fixture) => selectedNames.has(fixture.name));

function request(session: FamilyAcceptanceSession, fixture: JqCase): LaunchRequest {
  return {
    executable: "/usr/bin/jq",
    argv: ["jq", ...fixture.args],
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", PWD: "/", NO_COLOR: "1", ...fixture.env },
    fds: [
      { child: 0, parent: session.filledPipe(fixture.stdin ?? "") },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
}

async function execute(session: FamilyAcceptanceSession, fixture: JqCase) {
  const launched = request(session, fixture);
  try {
    return await session.exec(launched);
  } finally {
    session.descriptors.close(launched.fds[0]!.parent);
  }
}

async function proveJq(session: FamilyAcceptanceSession) {
  const oracle = readOracle();
  for (const fixture of selected) {
    const expected = oracle.cases[fixture.name];
    assert.ok(expected, fixture.name);
    const result = await execute(session, fixture);
    const stderr = decoder.decode(result.stderr);
    assert.equal(result.stdout.length > 0, expected.stdout.length > 0, fixture.name);
    assert.equal(decoder.decode(result.stdout), expected.stdout, fixture.name);
    if (fixture.error) {
      assert.equal(result.exit.kind === "exited" && result.exit.code, fixture.error.candidateExit);
      assert.ok(stderr.includes(fixture.error.candidateStderr), stderr);
    } else {
      assert.equal(result.exit.kind === "exited" && result.exit.code, expected.exit, stderr);
      assert.equal(stderr, expected.stderr, fixture.name);
    }
  }
}

test("optional jq catalog loads lazily and runs through the prepared runtime", async () => {
  assert.ok(basePackages.every((pkg) => pkg.name !== jq.name));
  assert.equal(jq.pick("jq").programs.length, 1);
  assert.throws(() => jq.pick("not-jq"), /Unknown program/);
  const runtime = createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [jq.pick("jq")] },
  });
  try {
    await runtime.programs.ready;
    assert.equal(runtime.programs.get("jq")?.state.kind, "registered");
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
      cases: [{ name: "real jq through onDemand", family: "coreutils", run: proveJq }],
    });
    assert.equal(runtime.programs.get("jq")?.state.kind, "loaded");
  } finally {
    await runtime.dispose();
  }
}, 90_000);
