import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

const directory = resolve(
  import.meta.dirname,
  "../../..",
  process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
  "wasm32-wasip1/release",
);
const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", LC_ALL: "C" };
const run = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  tmp: "/tmp/spec",
  env,
  fixtureDirectory: directory,
  utilityDirectory: directory,
});
const runWithoutUtilities = await createWaffleRunner({
  modulePath: resolve(directory, "shell-runtime.wasm"),
  tmp: "/tmp/spec",
  env,
  fixtureDirectory: directory,
});

const cases = [
  ["default stdin counts", "printf 'one two\\nthree\\n' | wc", "      2       3      14\n", 0],
  ["line selection", "printf 'one two\\nthree\\n' | wc -l", "2\n", 0],
  ["word selection", "printf 'one two\\nthree\\n' | wc -w", "3\n", 0],
  ["byte selection", "printf 'one two\\nthree\\n' | wc -c", "14\n", 0],
  ["binary byte selection", "printf '\\377\\000a b\\n' | wc -c", "6\n", 0],
  ["external pipeline input", "printf 'one two\\nthree\\n' | cat | wc -c", "14\n", 0],
  [
    "file operands and total",
    "printf 'a b\\n' > one; printf 'x\\ny z\\n' > two; wc one two",
    " 1  2  4 one\n 2  3  6 two\n 3  5 10 total\n",
    0,
  ],
  [
    "relative file uses the process directory",
    "mkdir nested; printf 'one two\\n' > nested/input; cd nested; wc input",
    "1 2 8 input\n",
    0,
  ],
] as const;

for (const [name, script, stdout, status] of cases) {
  test(`wc produces exact output for ${name}`, { timeout: 10000 }, async () => {
    const actual = await run(script);
    assert.equal(actual.status, status, actual.stderr.toString());
    assert.equal(actual.stdout.toString("latin1"), stdout, actual.stderr.toString());
    assert.equal(actual.stderr.length, 0);
  });
}

test("wc stays absent until installed", { timeout: 10000 }, async () => {
  const actual = await runWithoutUtilities("wc");
  assert.equal(actual.status, 127);
  assert.equal(actual.stdout.length, 0);
});

test("wc reports a missing file and returns status 1", { timeout: 10000 }, async () => {
  const actual = await run("wc missing");
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout.length, 0);
  assert.match(actual.stderr.toString(), /missing/);
});

test("wc rejects an invalid option with status 1", { timeout: 10000 }, async () => {
  const actual = await run("wc --not-an-option");
  assert.equal(actual.status, 1);
  assert.equal(actual.stdout.length, 0);
  assert.match(actual.stderr.toString(), /--not-an-option/);
});

test("wc stops when its downstream closes the pipe", { timeout: 15000 }, async () => {
  const name = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
  const script = `name=${name}; : > "$name"; printf -v files "$name %.0s" {1..1000}; set -o pipefail; wc $files | { IFS= read -r first; printf '%s\\n' "$first"; }; printf 'STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`;
  const actual = await run(script);
  assert.equal(actual.status, 0);
  assert.equal(actual.stdout.toString(), `0 0 0 ${name}\nSTATUS:1:1 0\n`);
  assert.match(actual.stderr.toString(), /broken pipe/i);
});
