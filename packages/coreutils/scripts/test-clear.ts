import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { verifyWasiGuest } from "../../../tools/program-build-tools.ts";

const guest = resolve(import.meta.dirname, "../dist/clear.wasm");
verifyWasiGuest(guest);
function invoke(args: readonly string[], term?: string, host = false) {
  const command = host ? "/usr/bin/clear" : "wasmtime";
  const parameters = host
    ? Array.from(args)
    : ["run"].concat(term === undefined ? [] : ["--env", `TERM=${term}`], [guest], args);
  const result = spawnSync(command, parameters, {
    env: { PATH: process.env.PATH },
    timeout: 10000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return result;
}

for (const term of ["xterm", "xterm-256color", "xterm-ghostty"]) {
  for (const args of [[], ["-x"], ["--"], ["-T", term], ["-x", "-T", term]]) {
    test(`clear WASI bytes: TERM=${term} ${args.join(" ")}`, () => {
      const actual = invoke(args, term);
      const expected = "\x1b[H\x1b[2J" + (args.includes("-x") ? "" : "\x1b[3J");
      assert.equal(actual.status, 0, actual.stderr.toString());
      assert.deepEqual(actual.stdout, Buffer.from(expected));
      assert.equal(actual.stderr.length, 0);
    });
  }
}

test("clear explicit profile works without TERM and last -T wins", () => {
  for (const args of [
    ["-T", "xterm"],
    ["-T", "dumb", "-T", "xterm"],
  ])
    assert.equal(invoke(args).stdout.toString(), "\x1b[H\x1b[2J\x1b[3J");
});

for (const term of [undefined, "", "dumb", "vt100", "unknown", "xterm-custom"]) {
  test(`clear rejects unsupported TERM=${String(term)} without output`, () => {
    const actual = invoke([], term);
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout.length, 0);
    assert.match(actual.stderr.toString(), /TERM is not set|unsupported terminal/);
  });
}
for (const args of [
  ["-x", "-bad"],
  ["file"],
  ["-T"],
  ["--", "file"],
  ["-V"],
  ["-xx"],
  ["-Txterm"],
  ["--help"],
]) {
  test(`clear rejects ${args.join(" ")} before terminal output`, () => {
    const actual = invoke(args, "xterm");
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout.length, 0);
    assert.match(actual.stderr.toString(), /usage|requires/);
  });
}

test("clear supported bytes and status match controlled host ncurses", () => {
  for (const term of ["xterm", "xterm-256color"]) {
    for (const args of [[], ["-x"]]) compareHost(term, args);
  }
});
function compareHost(term: string, args: string[]) {
  // -T controls ncurses independently of the host login environment or its TERM.
  const expected = invoke(["-T", term].concat(args), undefined, true);
  const actual = invoke(args, term);
  assert.equal(actual.status, expected.status, expected.stderr.toString());
  assert.deepEqual(actual.stdout, expected.stdout);
}

test("clear reports a WASI stdout write failure", () => {
  const sink = openSync("/dev/full", "w");
  try {
    const result = spawnSync("wasmtime", ["run", "--env", "TERM=xterm", guest], {
      stdio: ["ignore", sink, "pipe"],
      env: { PATH: process.env.PATH },
      timeout: 10000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /clear: write failed:/);
  } finally {
    closeSync(sink);
  }
});
