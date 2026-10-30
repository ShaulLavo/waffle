import assert from "node:assert/strict";
import { test } from "bun:test";
import { patchBuildScript, sourceIdentity } from "./patch.ts";
import { singleProgramBuilds } from "./prepare.ts";

test("changed or unknown upstream build sources fail closed", () => {
  for (const version of ["0.12.0", "0.13.0"]) {
    assert.equal(sourceIdentity(version).buildScriptSha256.length, 64);
    assert.throws(
      () => patchBuildScript("changed upstream source", version, "generate.rs", "wrapper.ts"),
      /Unpinned/,
    );
  }
  assert.throws(() => sourceIdentity("0.14.0"), /Unsupported/);
});

test("grouped coreutils invocations become explicit single-program Cargo calls", () => {
  const builds = singleProgramBuilds(
    ["-p", "waffle-cut", "-p", "waffle-tr", "-p", "waffle-clear", "--bins"],
    ["cut", "tr", "clear"],
  );
  assert.deepEqual(builds, [
    { program: "cut", args: ["-p", "waffle-cut", "--bin", "cut"] },
    { program: "tr", args: ["-p", "waffle-tr", "--bin", "tr"] },
    { program: "clear", args: ["-p", "waffle-clear", "--bin", "clear"] },
  ]);
  assert.deepEqual(
    singleProgramBuilds(
      ["-p", "waffle-coreutils", "--bins", "--features", "cooperative-wasi"],
      ["ls", "head"],
    ),
    [
      {
        program: "ls",
        args: ["--features", "cooperative-wasi", "-p", "waffle-coreutils", "--bin", "ls"],
      },
      {
        program: "head",
        args: ["--features", "cooperative-wasi", "-p", "waffle-coreutils", "--bin", "head"],
      },
    ],
  );
  assert.throws(() => singleProgramBuilds(["--all"], ["echo"]));
  assert.throws(() => singleProgramBuilds([], ["multicall"]));
});
