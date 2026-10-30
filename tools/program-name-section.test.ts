import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { programBytesIdentity, validateProgramDerivation } from "./program-derivation.ts";
import { stageProgram, stripWasmNames } from "./program-build-tools.ts";

const header = [0, 97, 115, 109, 1, 0, 0, 0];
const named = Uint8Array.from(
  header.concat([5, 5, 1, 1, 1, 128, 32], [0, 5, 4, 110, 97, 109, 101]),
);

function sourceFixture(context: TestContext) {
  const repository = resolve(import.meta.dirname, "..");
  const parent = resolve(repository, ".build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "program-staging-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = [
    "tools/program-build-tools.ts",
    "tools/program-optimize.ts",
    "tools/program-derivation.ts",
    "tools/program-locales/prepare.ts",
    "tools/program-locales/selection.ts",
    "tools/program-locales/patch.ts",
    "tools/program-locales/sources.json",
    "packages/coreutils/scripts/build-family.ts",
    "packages/coreutils/scripts/build-config.ts",
    "packages/coreutils/scripts/programs.ts",
    "packages/findutils/scripts/build-findutils.ts",
    "packages/findutils/scripts/xargs-source.ts",
    "packages/grep/scripts/build-grep.ts",
    "packages/sed/scripts/build-sed.ts",
    "packages/sed/scripts/build-config.ts",
    "packages/sed/scripts/sed-source.ts",
  ];
  for (const name of sources) {
    const target = resolve(root, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(repository, name), target);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "copied staging inputs",
    ],
    { cwd: root },
  );
  return (name: string) => pathToFileURL(resolve(root, name)).href;
}

test("program staging removes the name custom section from final bytes", async (context) => {
  const fixture = sourceFixture(context);
  const { stageGrep, releaseDirectory, packageRoot } = await import(
    fixture("packages/grep/scripts/build-grep.ts")
  );
  const paths = [resolve(releaseDirectory, "grep.wasm")].concat(
    ["dist", "public/programs"].map((directory) => resolve(packageRoot, directory, "grep.wasm")),
  );
  for (const path of paths) assert.equal(existsSync(path), false, `fixture would replace ${path}`);
  context.after(() => paths.forEach((path) => rmSync(path, { force: true })));
  mkdirSync(dirname(paths[0]!), { recursive: true });
  writeFileSync(paths[0]!, named);
  stageGrep();
  for (const path of paths.slice(1))
    assert.equal(
      WebAssembly.Module.customSections(new WebAssembly.Module(readFileSync(path)), "name").length,
      0,
    );
  assert.deepEqual(readFileSync(paths[0]!), Buffer.from(named), "compiler proof remains available");
});

function custom(name: string, content: readonly number[] = []) {
  const text = Array.from(new TextEncoder().encode(name));
  const payload = [text.length].concat(text, content);
  assert.ok(payload.length < 128);
  return [0, payload.length].concat(payload);
}

test("only name sections are removed, including repeated sections between code and metadata", () => {
  const preserved = custom("producers", [1, 2]).concat(
    custom("target_features", [3]),
    custom("dylink.0", [4, 5]),
    custom(".debug_info", [6]),
    custom("Name", [7]),
    custom("\uFEFFname", [9]),
    custom("", [8]),
    [5, 5, 1, 1, 1, 128, 32],
  );
  const input = Uint8Array.from(header.concat(custom("name"), preserved, custom("name", [0, 0])));
  const output = stripWasmNames(input);
  assert.deepEqual(Array.from(output), header.concat(preserved));
  assert.deepEqual(
    Array.from(input),
    header.concat(custom("name"), preserved, custom("name", [0, 0])),
  );
  assert.equal(stripWasmNames(output), output, "idempotent no-name identity");
});

test("no-name input is returned without copying or re-encoding padded section lengths", () => {
  const bytes = Uint8Array.from(header.concat([0, 0x82, 0, 0, 0]));
  assert.equal(stripWasmNames(bytes), bytes);
  const buffer = Buffer.from(header);
  assert.equal(stripWasmNames(buffer), buffer);
});

test("malformed framing is rejected even after a removable name section", () => {
  const malformed = [
    header.slice(0, -1),
    [0, 97, 115, 109, 2, 0, 0, 0],
    header.concat([0]),
    header.concat([0, 0x80]),
    header.concat([0, 0xff, 0xff, 0xff, 0xff, 0x10]),
    header.concat([0, 0x80, 0x80, 0x80, 0x80, 0x80, 0]),
    header.concat([1, 3, 0]),
    header.concat([0, 0]),
    header.concat([0, 1, 0x80]),
    header.concat([0, 2, 4, 110]),
    header.concat([0, 2, 1, 0xff]),
    header.concat(custom("name"), [0, 9, 4, 110, 97, 109, 101]),
  ];
  for (const bytes of malformed) assert.throws(() => stripWasmNames(Uint8Array.from(bytes)));
});

test("failed staging does not replace an existing destination", (context) => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "name-strip-failure-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  const input = resolve(root, "bad.wasm");
  const output = resolve(root, "output.wasm");
  writeFileSync(input, named.subarray(0, -1));
  writeFileSync(output, "untouched");
  assert.throws(() => stageProgram(input, output));
  assert.equal(readFileSync(output, "utf8"), "untouched");
});

test("base and JavaScript Git packages have no own Wasm artifacts to strip", () => {
  for (const family of ["base", "git"]) {
    const path = new URL(`../packages/${family}/package-artifacts.json`, import.meta.url);
    const recipe: unknown = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(
      recipe && typeof recipe === "object" && "files" in recipe && Array.isArray(recipe.files),
    );
    assert.equal(
      recipe.files.some((file: unknown) => typeof file === "string" && file.endsWith(".wasm")),
      false,
    );
  }
});

function programFixture(
  context: TestContext,
  release: string,
  root: string,
  names: readonly string[],
) {
  const originals = names.map((name) => resolve(release, `${name}.wasm`));
  const staged = names.flatMap((name) =>
    ["dist", "public/programs"].map((directory) => resolve(root, directory, `${name}.wasm`)),
  );
  const paths = originals.concat(staged);
  for (const path of paths) assert.equal(existsSync(path), false, `fixture would replace ${path}`);
  context.after(() => paths.forEach((path) => rmSync(path, { force: true })));
  for (const path of originals) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, named);
  }
  return () => {
    for (const path of originals) assert.deepEqual(readFileSync(path), Buffer.from(named));
    for (const path of staged) {
      const bytes = readFileSync(path);
      assert.equal(
        WebAssembly.Module.customSections(new WebAssembly.Module(bytes), "name").length,
        0,
      );
      const metadata = JSON.parse(readFileSync(path.replace(/\.wasm$/, "-program.json"), "utf8"));
      validateProgramDerivation(metadata, bytes);
      assert.deepEqual(metadata.input, programBytesIdentity(named));
    }
  };
}

test("coreutils staging finalizes ls and echo after retaining their compiler proof", async (context) => {
  const fixture = sourceFixture(context);
  const { stageFamilyPrograms } = await import(
    fixture("packages/coreutils/scripts/build-family.ts")
  );
  const config = await import(fixture("packages/coreutils/scripts/build-config.ts"));
  const names = ["ls", "echo"];
  const check = programFixture(context, config.releaseDirectory, config.packageRoot, names);
  stageFamilyPrograms(names);
  check();
});

test("findutils staging finalizes both find and xargs", async (context) => {
  const fixture = sourceFixture(context);
  const config = await import(fixture("packages/findutils/scripts/build-findutils.ts"));
  const check = programFixture(
    context,
    config.releaseDirectory,
    config.packageRoot,
    config.programNames,
  );
  config.stageFindutils();
  check();
});

test("sed staging finalizes the same bytes for package and direct URL consumers", async (context) => {
  const fixture = sourceFixture(context);
  const { stageSed } = await import(fixture("packages/sed/scripts/build-sed.ts"));
  const config = await import(fixture("packages/sed/scripts/build-config.ts"));
  const check = programFixture(context, config.releaseDirectory, config.packageRoot, ["sed"]);
  stageSed();
  check();
});
