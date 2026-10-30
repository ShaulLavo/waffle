import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { checksumNames } from "./build-checksums.ts";
import { fixturePath, readFixture } from "./checksum-oracle.ts";
import provenance from "../provenance/checksums.source.json" with { type: "json" };

const packageRoot = resolve(import.meta.dirname, "..");
const crateRoot = resolve(packageRoot, "crates/checksums");
const revision = "07763857f6b9a547742a994b58aef0ccd036198b";

function text(path: string) {
  return readFileSync(path, "utf8");
}

test("checksum source stays a pinned isolated upstream leaf", () => {
  const manifest = text(resolve(crateRoot, "Cargo.toml"));
  const lock = text(resolve(crateRoot, "Cargo.lock"));
  assert.match(manifest, /^\[workspace\]/m);
  assert.doesNotMatch(manifest, /path\s*=\s*["'][.][.][.][.]/);
  assert.equal((manifest.match(new RegExp(revision, "g")) ?? []).length, 10);
  assert.match(
    lock,
    new RegExp(`source = "git\\+https://github\\.com/uutils/coreutils\\?rev=${revision}`),
  );
  for (const name of checksumNames) {
    assert.equal(
      text(resolve(crateRoot, `src/bin/${name}.rs`)),
      `#[path = "../cwd.rs"]\nmod cwd;\n\nmod upstream {\n    uucore::bin!(uu_${name});\n}\n\nfn main() {\n    cwd::initialize("${name}");\n    upstream::main();\n}\n`,
    );
    assert.match(manifest, new RegExp(`uu_${name}`));
  }
  assert.match(manifest, /\[patch\."https:\/\/github.com\/uutils\/coreutils"\]/);
  assert.match(text(resolve(crateRoot, "src/stdio.rs")), /fn fd_read\(/);
  assert.match(text(resolve(crateRoot, "src/stdio.rs")), /fn fd_write\(/);
  assert.equal(provenance.revision, revision);
  assert.deepEqual(provenance.utilities, checksumNames);
  assert.ok(provenance.localChanges.some((change) => change.includes("selected-I/O")));
});

test("checksum oracle fixture seals every requested utility", () => {
  const fixture = readFixture();
  assert.equal(
    createHash("sha256").update(readFileSync(fixturePath)).digest("hex"),
    provenance.oracle.fixtureSha256,
  );
  assert.equal(fixture.upstreamRevision, revision);
  assert.deepEqual(Object.keys(fixture.utilities), checksumNames);
  assert.deepEqual(
    fixture.cases
      .filter((entry) => entry.name.endsWith("reads stdin"))
      .map((entry) => entry.utility),
    checksumNames,
  );
});
