import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import * as locales from "./prepare.ts";
import { sha256 } from "./patch.ts";

function fixture(context: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "waffle-owned-locales-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = resolve(root, "packages/coreutils/.sources/checksums");
  mkdirSync(directory, { recursive: true });
  const source = resolve(directory, "lib.rs");
  writeFileSync(source, "sealed compiler input");
  const receipt = resolve(directory, "waffle-source.json");
  const revision = "07763857f6b9a547742a994b58aef0ccd036198b";
  writeFileSync(
    receipt,
    JSON.stringify({ revision, inputs: [], files: { "lib.rs": sha256(readFileSync(source)) } }),
  );
  const owned = { directory, revision, receiptSha256: sha256(readFileSync(receipt)) };
  return { root, owned, directory, source, receipt };
}

test("owned locales require the exact generated directory and receipt identity", (context) => {
  const { root, owned, directory, receipt } = fixture(context);
  locales.verifyOwnedLocaleSource(root, owned);
  const other = resolve(root, "other");
  mkdirSync(other);
  assert.throws(
    () => locales.verifyOwnedLocaleSource(root, { ...owned, directory: other }),
    /sealed checksum directory/,
  );
  assert.throws(
    () => locales.verifyOwnedLocaleSource(root, { ...owned, receiptSha256: "0".repeat(64) }),
    /receipt digest/,
  );
  writeFileSync(receipt, readFileSync(receipt, "utf8") + "\n");
  assert.throws(() => locales.verifyOwnedLocaleSource(root, owned), /receipt digest/);
  assert.equal(owned.directory, directory);
});

test("owned locales reject changed, added and removed compiler source", (context) => {
  const { root, owned, directory, source } = fixture(context);
  writeFileSync(source, "changed compiler input");
  assert.throws(() => locales.verifyOwnedLocaleSource(root, owned), /sealed source changed/);
  writeFileSync(source, "sealed compiler input");
  const extra = resolve(directory, "unsealed.rs");
  writeFileSync(extra, "additional compiler input");
  assert.throws(() => locales.verifyOwnedLocaleSource(root, owned), /sealed source changed/);
  rmSync(extra);
  rmSync(source);
  assert.throws(() => locales.verifyOwnedLocaleSource(root, owned), /sealed source changed/);
});

test("owned locales reject revision relabeling and unsealed symbolic links", (context) => {
  const { root, owned, directory } = fixture(context);
  assert.throws(
    () => locales.verifyOwnedLocaleSource(root, { ...owned, revision: "other" }),
    /receipt revision/,
  );
  const outside = resolve(root, "outside.rs");
  writeFileSync(outside, "unsealed compiler input");
  symlinkSync(outside, resolve(directory, "linked.rs"));
  assert.throws(() => locales.verifyOwnedLocaleSource(root, owned), /symbolic link escapes/);
});

test("owned locales seal internal symbolic link targets", (context) => {
  const { root, owned, directory, receipt } = fixture(context);
  const link = resolve(directory, "internal.rs");
  symlinkSync("lib.rs", link);
  const sealed = {
    revision: owned.revision,
    inputs: [],
    files: {
      "lib.rs": sha256("sealed compiler input"),
      "internal.rs": sha256("symlink\0lib.rs"),
    },
  };
  writeFileSync(receipt, JSON.stringify(sealed));
  const withLink = { ...owned, receiptSha256: sha256(readFileSync(receipt)) };
  locales.verifyOwnedLocaleSource(root, withLink);
  rmSync(link);
  symlinkSync("./lib.rs", link);
  assert.throws(() => locales.verifyOwnedLocaleSource(root, withLink), /sealed source changed/);
});

test("owned locales reject a symlink replacing the sealed directory", (context) => {
  const { root, owned, directory } = fixture(context);
  rmSync(directory, { recursive: true });
  const outside = resolve(root, "replacement");
  mkdirSync(outside);
  symlinkSync(outside, directory, "dir");
  assert.throws(() => locales.verifyOwnedLocaleSource(root, owned), /sealed checksum directory/);
});

test("owned source validation precedes Cargo metadata", (context) => {
  const { root, owned } = fixture(context);
  assert.throws(
    () =>
      locales.prepareProgramLocales({
        root,
        program: "sha256sum",
        env: {
          ...process.env,
          RUSTC_WRAPPER: undefined,
          CARGO_TARGET_DIR: resolve(root, "target"),
        },
        manifest: resolve(root, "missing-Cargo.toml"),
        ownedSource: { ...owned, directory: root },
      }),
    /sealed checksum directory/,
  );
});
