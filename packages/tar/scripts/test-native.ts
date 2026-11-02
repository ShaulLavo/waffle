import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./build-tar.ts";
import { command, native, nativeIdentity, text, withFixtures } from "../tests/fixtures.ts";

await withFixtures(async (fixtures) => {
  const identity = nativeIdentity();
  const list = command(native, ["-tf", "fixture.tar"], fixtures.directory);
  const gnu = command("/usr/bin/tar", ["-tf", "fixture.tar"], fixtures.directory);
  assert.equal(list.status, 0, text(list.stderr));
  assert.equal(text(list.stdout), fixtures.expectedList);
  assert.deepEqual(list.stdout, gnu.stdout);
  const cases = fixtures.cases.map((fixture) => {
    const result = command(native, fixture.args, fixtures.directory, fixture.input);
    if (fixture.name === "gzip checksum failure") assert.equal(result.status, 2);
    return {
      name: fixture.name,
      status: result.status,
      stdout: text(result.stdout),
      stderr: text(result.stderr).replaceAll(fixtures.directory, "<fixture>"),
    };
  });
  for (const compressed of [false, true]) {
    const archive = resolve(fixtures.directory, compressed ? "created.tar.gz" : "created.tar");
    const created = command(
      native,
      [compressed ? "-czvf" : "-cvf", archive, "-C", "source", "alpha.txt", "tree"],
      fixtures.directory,
    );
    assert.equal(created.status, 0, text(created.stderr));
    const listing = command(native, ["-tf", archive], fixtures.directory);
    assert.equal(listing.status, 0, text(listing.stderr));
    // uutils does not append a slash to every nested directory header it writes.
    const members = (value: string) =>
      value
        .trimEnd()
        .split("\n")
        .map((name) => name.replace(/\/$/, ""));
    assert.deepEqual(members(text(listing.stdout)), members(fixtures.expectedList));
    const destination = resolve(fixtures.directory, compressed ? "out-gzip" : "out-tar");
    mkdirSync(destination);
    const extracted = command(native, ["-xf", archive, "-C", destination], fixtures.directory);
    assert.equal(extracted.status, 0, text(extracted.stderr));
    for (const name of ["alpha.txt", "tree/sub/binary"])
      assert.deepEqual(
        readFileSync(resolve(destination, name)),
        readFileSync(resolve(fixtures.directory, "source", name)),
      );
  }
  const pipe = command(native, ["-cf", "-", "-C", "source", "alpha.txt"], fixtures.directory);
  assert.equal(pipe.status, 0, text(pipe.stderr));
  const pipeList = command(native, ["-tf", "-"], fixtures.directory, pipe.stdout);
  assert.equal(pipeList.status, 0, text(pipeList.stderr));
  assert.equal(text(pipeList.stdout), "alpha.txt\n");
  console.log(
    JSON.stringify(
      {
        identity,
        inputTarSha256: sha256(fixtures.archive),
        inputGzipSha256: sha256(fixtures.gzip),
        nativeCreateExtract:
          "plain, gzip, directories, multiple files, verbose and stdout pipeline passed",
        cases,
      },
      null,
      2,
    ),
  );
});
