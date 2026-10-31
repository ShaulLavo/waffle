import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import observations from "../fixtures/sort-uniq.json" with { type: "json" };
import { loadSortUniqObservations } from "./sort-uniq-observations.ts";

const root = resolve(import.meta.dirname, "..");
const utilities = [
  "env",
  "clear",
  "cat",
  "cut",
  "tr",
  "head",
  "which",
  "ls",
  "mkdir",
  "seq",
  "sort",
  "tail",
  "uniq",
  "wc",
  "touch",
  "rm",
  "cp",
  "mv",
] as const;

const sortUniqTransitiveNotices = [
  "calendrical_calculations 0.2.4 / LICENSE",
  "chacha20 0.10.2 / LICENSE-APACHE",
  "chacha20 0.10.2 / LICENSE-MIT",
  "core_maths 0.1.1 / LICENSE",
  "cpufeatures 0.3.1 / LICENSE-APACHE",
  "cpufeatures 0.3.1 / LICENSE-MIT",
  "crossbeam-deque 0.8.8 / LICENSE-APACHE",
  "crossbeam-deque 0.8.8 / LICENSE-MIT",
  "crossbeam-epoch 0.9.21 / LICENSE-APACHE",
  "crossbeam-epoch 0.9.21 / LICENSE-MIT",
  "crossbeam-utils 0.8.23 / LICENSE-APACHE",
  "crossbeam-utils 0.8.23 / LICENSE-MIT",
  "ctrlc 3.5.2 / LICENSE-APACHE",
  "ctrlc 3.5.2 / LICENSE-MIT",
  "fastrand 2.5.0 / LICENSE-APACHE",
  "fastrand 2.5.0 / LICENSE-MIT",
  "fixed_decimal 0.7.3 / LICENSE",
  "foldhash 0.2.0 / LICENSE",
  "getrandom 0.4.3 / LICENSE-APACHE",
  "getrandom 0.4.3 / LICENSE-MIT",
  "icu_calendar 2.4.0 / LICENSE",
  "icu_calendar_data 2.4.0 / LICENSE",
  "icu_datetime 2.4.0 / LICENSE",
  "icu_datetime_data 2.4.0 / LICENSE",
  "icu_decimal 2.4.0 / LICENSE",
  "icu_decimal_data 2.4.0 / LICENSE",
  "icu_pattern 0.5.1 / LICENSE",
  "icu_plurals 2.4.0 / LICENSE",
  "icu_plurals_data 2.4.0 / LICENSE",
  "icu_time 2.4.0 / LICENSE",
  "icu_time_data 2.4.0 / LICENSE",
  "jiff-icu 0.2.2 / COPYING",
  "jiff-icu 0.2.2 / LICENSE-MIT",
  "rand 0.10.3 / LICENSE-APACHE",
  "rand 0.10.3 / LICENSE-MIT",
  "rand_core 0.10.1 / LICENSE-APACHE",
  "rand_core 0.10.1 / LICENSE-MIT",
  "rayon 1.12.0 / LICENSE-APACHE",
  "rayon 1.12.0 / LICENSE-MIT",
  "rayon-core 1.13.0 / LICENSE-APACHE",
  "rayon-core 1.13.0 / LICENSE-MIT",
  "tempfile 3.27.0 / LICENSE-APACHE",
  "tempfile 3.27.0 / LICENSE-MIT",
] as const;

async function bundle(entry: string): Promise<string> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
    external: ["waffle", "waffle/*"],
    logLevel: "silent",
  });
  return result.outputFiles.map((file) => file.text).join("\n");
}

test("package exports one core entry and one entry per utility", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const expected = Object.fromEntries(
    utilities
      .map((name) => [`./utilities/${name}`, `./src/utilities/${name}.ts`])
      .concat([["./utilities/git", "./src/utilities/git.ts"]]),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.exports).filter(([key]) => key.startsWith("./utilities/")),
    ),
    expected,
  );
  assert.equal(manifest.exports["."], "./src/index.ts");
});

test("the core entry references no utility program", async () => {
  for (const entry of ["src/index.ts", "src/shell.ts"]) {
    const text = await bundle(entry);
    for (const name of utilities) assert.doesNotMatch(text, new RegExp(`${name}\\.wasm`), entry);
  }
});

test("each utility entry references only its own program", async () => {
  for (const name of utilities) {
    const text = await bundle(`src/utilities/${name}.ts`);
    assert.match(text, new RegExp(`dist/${name}\\.wasm`));
    for (const other of utilities.filter((value) => value !== name))
      assert.doesNotMatch(text, new RegExp(`${other}\\.wasm`), `${name} entry`);
    assert.match(text, new RegExp(`function install${name[0].toUpperCase()}${name.slice(1)}`));
  }
});

test("head packages the pinned upstream entry and its license notices", () => {
  const manifest = readFileSync(resolve(root, "shell/utilities/Cargo.toml"), "utf8");
  for (const name of ["uu_head", "uucore"])
    assert.match(manifest, new RegExp(`${name} = "=0\\.12\\.0"`));
  const entry = readFileSync(resolve(root, "shell/utilities/src/bin/head.rs"), "utf8");
  assert.match(entry, /uucore::bin!\(uu_head\)/);
  const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.match(notices, /## uu_head 0\.12\.0 \/ LICENSE/);
  assert.match(notices, /## uucore 0\.12\.0 \/ LICENSE/);
});

test("wc packages the surveyed upstream source, scalar build and license", () => {
  const revision = "07763857f6b9a547742a994b58aef0ccd036198b";
  const manifest = readFileSync(resolve(root, "shell/wc/Cargo.toml"), "utf8");
  for (const name of ["uu_wc", "uucore"]) {
    assert.match(manifest, new RegExp(`${name} = \\{ git = "https://github.com/uutils/coreutils"`));
    assert.match(manifest, new RegExp(`rev = "${revision}"`));
  }
  const entry = readFileSync(resolve(root, "shell/wc/src/bin/wc.rs"), "utf8");
  assert.match(entry, /uucore::bin!\(uu_wc\)/);
  const build = readFileSync(resolve(root, "scripts/build-wc.ts"), "utf8");
  assert.match(build, /target-feature=-simd128/);
  const bytecount = readFileSync(resolve(root, "shell/wc/vendor/bytecount/src/lib.rs"), "utf8");
  assert.match(bytecount, /all\(target_arch = "wasm32", target_feature = "simd128"\)/);
  const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.match(notices, /## waffle-wc 0\.0\.1 \/ LICENSE\.uutils-coreutils/);
});

for (const name of ["sort", "uniq"]) {
  test(`${name} packages the exact upstream crate and license`, () => {
    const manifest = readFileSync(resolve(root, "shell/utilities/Cargo.toml"), "utf8");
    assert.ok(manifest.includes(`uu_${name} = "=0.12.0"`));
    const entry = readFileSync(resolve(root, `shell/utilities/src/bin/${name}.rs`), "utf8");
    assert.ok(entry.includes(`uucore::bin!(uu_${name})`));
    assert.ok(entry.includes(`cwd::initialize("${name}")`));
    const cwd = readFileSync(resolve(root, "shell/utilities/src/sort_uniq_cwd.rs"), "utf8");
    assert.match(cwd, /std::env::set_current_dir/);
    const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    assert.ok(notices.includes(`## uu_${name} 0.12.0 / LICENSE`));
  });
}

test("sort and uniq retain every approved transitive license notice", () => {
  const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const heading of sortUniqTransitiveNotices)
    assert.ok(notices.includes(`## ${heading}\n`), heading);
});

test("sort and uniq source receipts match the locked registry packages", () => {
  const receipt = JSON.parse(readFileSync(resolve(root, "docs/sort-uniq-source.json"), "utf8"));
  assert.equal(receipt.revision, "dc1efd89948a9ca4c78c3a4b9a6ac891019a8c69");
  const lock = readFileSync(resolve(root, "../../Cargo.lock"), "utf8");
  assert.deepEqual(
    receipt.packages.map((pkg: { name: string }) => pkg.name),
    ["uu_sort", "uu_uniq"],
  );
  for (const pkg of receipt.packages) {
    assert.ok(
      lock.includes(
        `name = "${pkg.name}"\nversion = "${pkg.version}"\nsource = "${pkg.registry}"\nchecksum = "${pkg.sha256}"`,
      ),
    );
  }
});

test("sort and uniq qualification cannot import a live host oracle", async () => {
  const result = await build({
    entryPoints: ["scripts/test-own-shell-sort-uniq.ts", "tests/sort-uniq.spec.ts"],
    outdir: "unused",
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    logLevel: "silent",
  });
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    assert.equal(
      input.imports.some((entry) => /^(?:node:)?child_process$/.test(entry.path)),
      false,
      `${path} admits a host subprocess into sort/uniq qualification`,
    );
  }
});

test("sort and uniq reject missing, changed, and invalid frozen observations", () => {
  assert.equal(loadSortUniqObservations().length, 25);
  const missing = structuredClone(observations);
  missing.cases.pop();
  assert.throws(() => loadSortUniqObservations(missing), /must match every case/);
  const changed = structuredClone(observations);
  changed.cases[0].script += "; true";
  assert.throws(() => loadSortUniqObservations(changed), /must match every case/);
  const malformed = structuredClone(observations);
  malformed.cases[0].stdout = [256];
  assert.throws(() => loadSortUniqObservations(malformed));
  const wrongOracle = structuredClone(observations);
  wrongOracle.oracle.bash.version = "host bash";
  assert.throws(() => loadSortUniqObservations(wrongOracle));
});

test("native sort and uniq qualification runs candidates, not host GNU programs", () => {
  const source = readFileSync(resolve(root, "shell/utilities/tests/sort_uniq.rs"), "utf8");
  assert.match(source, /owned-fixtures\/sort-uniq\.json/);
  assert.doesNotMatch(source, /run\(name,|Command::new\("(?:bash|sort|uniq)"\)/);
});

test("env packages the exact print-only upstream source and root license", () => {
  const receipt = JSON.parse(
    readFileSync(resolve(root, "shell/utilities/env.source.json"), "utf8"),
  );
  const revision = "07763857f6b9a547742a994b58aef0ccd036198b";
  assert.equal(receipt.repository, "https://github.com/uutils/coreutils");
  assert.equal(receipt.revision, revision);
  assert.deepEqual(receipt.packages, { uu_env: { version: "0.13.0", path: "src/uu/env" } });
  assert.equal(receipt.sharedPackage.dependencyAlias, "uucore_files");
  const manifest = readFileSync(resolve(root, "shell/utilities/Cargo.toml"), "utf8");
  assert.ok(manifest.includes('uu_env = { path = "../../third-party/uutils-env" }'));
  const localManifest = readFileSync(resolve(root, receipt.localPackage, "Cargo.toml"), "utf8");
  assert.ok(
    localManifest.includes(
      `uucore = { git = "${receipt.repository}", rev = "${revision}", features = ["signals"] }`,
    ),
  );
  const provenance = JSON.parse(
    readFileSync(resolve(root, receipt.localPackage, "provenance.json"), "utf8"),
  );
  assert.equal(provenance.revision, revision);
  for (const [path, digest] of Object.entries(provenance.files)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(resolve(root, receipt.localPackage, path)))
        .digest("hex"),
      digest,
      path,
    );
  }
  const lock = readFileSync(resolve(root, "../../Cargo.lock"), "utf8");
  assert.ok(lock.includes(`name = "uu_env"\nversion = "0.13.0"\ndependencies = [`));
  const entry = readFileSync(resolve(root, "shell/utilities/src/bin/env.rs"), "utf8");
  assert.match(entry, /extern crate uucore_files as uucore/);
  assert.match(entry, /uucore::bin!\(uu_env\)/);
  assert.doesNotMatch(entry, /process::Command|runtime_proc/);
  const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.ok(notices.includes(`## uutils coreutils ${revision} / LICENSE`));
});

for (const name of ["cut", "tr"]) {
  test(`${name} packages the accepted upstream wrapper, ordinary admission and notices`, () => {
    const revision = "07763857f6b9a547742a994b58aef0ccd036198b";
    const manifest = readFileSync(resolve(root, `shell/${name}/Cargo.toml`), "utf8");
    for (const dependency of [`uu_${name}`, "uucore"])
      assert.ok(
        manifest.includes(
          `${dependency} = { git = "https://github.com/uutils/coreutils", rev = "${revision}" }`,
        ),
      );
    const entry = readFileSync(resolve(root, `shell/${name}/src/main.rs`), "utf8");
    assert.ok(entry.includes(`uucore::bin!(uu_${name})`));
    if (name === "cut") {
      assert.match(entry, /std::env::var\("PWD"\)/);
      assert.match(entry, /std::env::set_current_dir\(&cwd\)/);
    }
    const installer = readFileSync(resolve(root, `src/utilities/${name}.ts`), "utf8");
    assert.match(installer, /execution: "wasi"/);
    assert.match(installer, /WasiUtilityOptions/);
    const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    assert.ok(notices.includes(`## uu_${name} 0.13.0 / LICENSE`));
    assert.ok(notices.includes(`## uutils coreutils ${revision} / LICENSE`));
  });
}

test("clear ships original source and its MIT notice", () => {
  const manifest = readFileSync(resolve(root, "shell/clear/Cargo.toml"), "utf8");
  assert.doesNotMatch(manifest, /\[dependencies\]/);
  const license = readFileSync(resolve(root, "shell/clear/LICENSE"), "utf8");
  assert.equal(license, readFileSync(resolve(root, "LICENSE"), "utf8"));
  const notices = readFileSync(resolve(root, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.ok(notices.includes(`## waffle-clear 0.0.1 / LICENSE\n\n${license}`));
});
