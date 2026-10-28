import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixtures = [
  {
    path: "packages/coreutils/fixtures/cut-tr.json",
    sha256: "570bc21ba9b602cff273a164b6077521da0418d81703a2c74a404e1de3da4129",
  },
  {
    path: "packages/findutils/provenance/bash/tests/helpers/find-cases.ts",
    sha256: "787803c753613f3f4cef8a4aae8af76162144757a4327defbec343aa61003a50",
  },
  {
    path: "packages/grep/tests/fixtures/grep-usage-cases.json",
    sha256: "95c18028d52a067a263e1a716568f8e1c5be3243f4c3da2120be9157a20d36a8",
  },
  {
    path: "packages/ripgrep/tests/helpers/rg-fixtures.ts",
    sha256: "925892683d735764e9aaf27df44ac4eada77db130ebf8e183ac44f2502aef419",
  },
  {
    path: "packages/sed/provenance/bash/tests/sed-installed-app.ts",
    sha256: "2b4add220ea037db030ecd02154efdc2f5b3909aa7df1433926ee8fd2fe4b0ba",
  },
] as const;

test("frozen family fixture inputs retain their exact bytes at final paths", () => {
  for (const fixture of fixtures) {
    const bytes = readFileSync(resolve(root, fixture.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256, fixture.path);
  }
});

test("runner binds real packages and the generic worker without a product substitute", () => {
  const source = readFileSync(resolve(root, "tools/family-acceptance.ts"), "utf8");
  for (const binding of [
    "installPrograms(runtime, packages, { launcher })",
    "service.launchWorker(context",
    "readonly runtime: Runtime",
    "assets.coreutils",
    "assets.findutils",
    "assets.grep",
    "assets.sed",
    "assets.ripgrep",
    "session.dispose()",
    "installation.dispose()",
  ]) {
    assert.ok(source.includes(binding), `Missing real runner binding: ${binding}`);
  }
  for (const forbidden of [
    "bash-web",
    "createRuntime(",
    "new Worker(",
    "new WebAssembly.Module",
    "registerAdapter(",
    "registerProgram(",
    "runtime_proc.",
  ]) {
    assert.ok(!source.includes(forbidden), `Unexpected runner dependency: ${forbidden}`);
  }
});

test("representative case set covers every family, descriptors and interruption", () => {
  const source = readFileSync(resolve(root, "tools/family-acceptance.ts"), "utf8");
  for (const name of [
    "coreutils cut cwd and shared filesystem",
    "find exact byte size",
    "xargs internal echo",
    "grep numbered inverted bytes",
    "sed unterminated output",
    "ripgrep explicit stdin",
    "env forwards descriptors and unbound fd fails",
    "cat interrupted on an open pipe",
  ]) {
    assert.ok(source.includes(`name: "${name}"`), `Missing acceptance case: ${name}`);
  }
  for (const fixture of fixtures.slice(0, 4)) {
    assert.ok(source.includes(`../${fixture.path}`), `Fixture is not imported: ${fixture.path}`);
  }
});
