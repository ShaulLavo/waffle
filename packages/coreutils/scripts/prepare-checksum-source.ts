import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { OwnedLocaleSource } from "../../../tools/program-locales/prepare.ts";

export const checksumRevision = "07763857f6b9a547742a994b58aef0ccd036198b";
const root = resolve(import.meta.dirname, "..");
const crate = resolve(root, "crates/checksums");
const patch = resolve(crate, "patches/selected-io-and-escaped-records.patch");
export const checksumSource = resolve(root, ".sources/checksums");

function git(source: string, args: readonly string[]) {
  return execFileSync("git", ["-C", source].concat(args), { encoding: "utf8" });
}

function upstreamSource() {
  const selected = process.env.CHECKSUM_UPSTREAM_SOURCE;
  if (selected) return selected;
  const cache = resolve(process.env.CARGO_HOME ?? resolve(homedir(), ".cargo"), "git/checkouts");
  const repositories = readdirSync(cache).filter((name) => name.startsWith("coreutils-"));
  const checkouts = repositories.flatMap((name) => {
    const repository = resolve(cache, name);
    return readdirSync(repository).map((entry) => resolve(repository, entry));
  });
  const source = checkouts.find(
    (path) =>
      existsSync(resolve(path, ".git")) &&
      git(path, ["rev-parse", "HEAD"]).trim() === checksumRevision,
  );
  assert.ok(source, "Set CHECKSUM_UPSTREAM_SOURCE to the exact pinned Cargo Git checkout");
  return source;
}

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name).slice(root.length + 1))
    .filter((name) => name !== "waffle-source.json")
    .sort();
}

function identity(directory: string) {
  return Object.fromEntries(
    files(directory).map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(resolve(directory, name)))
        .digest("hex"),
    ]),
  );
}

function inputs() {
  return [
    import.meta.filename,
    patch,
    resolve(crate, "src/stdio.rs"),
    resolve(crate, "src/record_tests.rs"),
  ].map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
}

function materialize(source: string, destination: string) {
  const archive = execFileSync("git", ["-C", source, "archive", checksumRevision], {
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", destination], { input: archive });
  const manifest = resolve(destination, "Cargo.toml");
  const original = readFileSync(manifest, "utf8");
  const workspace = original.slice(
    original.indexOf("[workspace]"),
    original.indexOf("\n[dependencies]\n"),
  );
  const members = '["src/uucore", "src/uucore_procs", "src/uu/checksum_common", "src/uu/sum"]';
  writeFileSync(manifest, workspace.replace(/members = \[[\s\S]*?\n\]/, `members = ${members}`));
  execFileSync("git", ["apply", "--unidiff-zero", patch], { cwd: destination });
  const checksum = resolve(destination, "src/uucore/src/lib/features/checksum");
  for (const name of ["stdio.rs", "record_tests.rs"])
    writeFileSync(resolve(checksum, name), readFileSync(resolve(crate, "src", name)));
}

function sealed(): OwnedLocaleSource {
  const receipt = readFileSync(resolve(checksumSource, "waffle-source.json"));
  return {
    directory: checksumSource,
    revision: checksumRevision,
    receiptSha256: createHash("sha256").update(receipt).digest("hex"),
  };
}

/** Exports, patches and seals the dependency tree; locale selection binds its receipt hash. */
export function prepareChecksumSource(): OwnedLocaleSource {
  const source = upstreamSource();
  assert.equal(git(source, ["rev-parse", "HEAD"]).trim(), checksumRevision);
  const expectedInputs = inputs();
  if (existsSync(checksumSource)) {
    const receipt: unknown = JSON.parse(
      readFileSync(resolve(checksumSource, "waffle-source.json"), "utf8"),
    );
    assert.deepEqual(
      receipt,
      { revision: checksumRevision, inputs: expectedInputs, files: identity(checksumSource) },
      "Patched checksum source changed; remove the owned generated source before preparing again",
    );
    return sealed();
  }
  mkdirSync(dirname(checksumSource), { recursive: true });
  const temporary = mkdtempSync(resolve(dirname(checksumSource), ".checksums-"));
  try {
    materialize(source, temporary);
    const receipt = {
      revision: checksumRevision,
      inputs: expectedInputs,
      files: identity(temporary),
    };
    writeFileSync(
      resolve(temporary, "waffle-source.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    renameSync(temporary, checksumSource);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return sealed();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  prepareChecksumSource();
