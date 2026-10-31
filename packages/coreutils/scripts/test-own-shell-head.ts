import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import type * as Api from "./waffle-node-api.ts";
import oracle from "../fixtures/head-gnu.json" with { type: "json" };

const nodeDirectory = new URL("../.build/node/", import.meta.url);
const directory = resolve(
  import.meta.dirname,
  "../../..",
  process.env.CARGO_TARGET_DIR ?? ".build/coreutils",
  "wasm32-wasip1/release",
);
const api: typeof Api = await import(new URL("api.mjs", nodeDirectory).href);
const shell = await WebAssembly.compile(await readFile(resolve(directory, "shell-runtime.wasm")));
const head = new Uint8Array(await readFile(resolve(directory, "head.wasm")));
const env = { PATH: "/usr/bin:/bin", HOME: "/home/user", LC_ALL: "C" };

async function run(context: TestContext, script: string, installed = true, interrupt = false) {
  const admitted = Promise.withResolvers<number>();
  installNodeWorkers();
  const runtime = api.createRuntime({
    sharedMemory: testSharedMemory,
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
    onProcessAdmission(event) {
      if (event.stage === "launched") admitted.resolve(event.pid);
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stop = () => {};
  context.after(async () => {
    stop();
    await runtime.dispose();
    await stopNodeWorkers();
    assert.equal(liveNodeWorkers(), 0);
  });
  for (const path of ["/tmp/spec", "/bin", "/home/user"]) await runtime.filesystem.mkdirp(path);
  if (installed)
    await api.installHead(runtime, {
      workerUrl: new URL("shell.mjs", nodeDirectory),
      source: head,
    });
  await runtime.filesystem.drain();
  const completion = runRoot(
    runtime,
    api,
    shell,
    { modulePath: "", tmp: "/tmp/spec", env, fixtureDirectory: directory },
    script,
    (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
    (terminate) => {
      stop = terminate;
    },
  );
  if (interrupt) {
    const pid = await admitted.promise;
    await setTimeout(25);
    const service = await runtime.processes();
    await service.kill(pid, 2);
  }
  const status = await completion;
  return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

const cases = [
  ["default ten lines", "for ((i=1;i<=12;i++)); do printf '%s\\n' \"$i\"; done | head"],
  ["attached line count", "printf 'one\\ntwo\\nthree' | head -n2"],
  ["long line count", "printf 'one\\ntwo\\nthree' | head --lines=+2"],
  ["legacy count", "printf 'one\\ntwo\\nthree' | head -1"],
  ["byte count preserves binary", "printf '\\377\\000abc\\n' | head -c3"],
  ["long byte count", "printf 'abcdef' | head --bytes 2"],
  ["suffix count", "printf 'abcdef' | head -c 1KB"],
  ["last mode wins", "printf 'ab\\ncd\\nef' | head -n1 -c4"],
  ["file and missing newline", "printf 'one\\ntwo' > f; head -n9 f"],
  ["multiple file headers", "printf 'a\\nb\\n' > a; printf xyz > b; head -n1 a b"],
  ["quiet headers", "printf a > a; printf b > b; head --quiet a b"],
  ["verbose stdin header", "printf 'one\\ntwo\\n' | head --verbose -n1 -"],
  ["option after file", "printf 'one\\ntwo\\n' > f; head f -n1"],
  ["option terminator", "printf 'one\\ntwo\\n' > ./-n; head -n1 -- -n"],
  ["zero leaves stdin", "printf 'one\\ntwo\\n' | { head -n0; head -n1; }"],
  ["missing operand continues", "printf 'ok\\n' > f; head -q missing f"],
  ["missing count", "head -n"],
  ["invalid count", "head --lines=oops"],
  ["invalid suffix", "head -c 1J"],
  ["unsupported option", "head --not-an-option"],
  ["all but last line", "printf 'a\\nb\\nc\\n' | head -n -1"],
  ["all but last bytes", "printf abcdef | head -c -2"],
  ["NUL-delimited records", "printf 'a\\000b\\000c' | head -z -n2"],
  [
    "early prefix from running producer",
    "{ printf 'ready\\n'; while printf x; do :; done; } | head -n1",
  ],
] as const;

assert.equal(oracle.schema, 1);
assert.equal(
  oracle.oracle.bash.version,
  "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)",
);
assert.deepEqual(oracle.environment, env);
assert.deepEqual(
  oracle.cases.map((entry) => [entry.name, entry.script]),
  cases,
);

for (const expected of oracle.cases) {
  const { name, script } = expected;
  test(`head matches GNU output and status for ${name}`, { timeout: 10000 }, async (context) => {
    const actual = await run(context, script);
    assert.equal(actual.status, expected.status);
    const stdout = Buffer.from(expected.stdoutBase64, "base64");
    const expectedStdout =
      name === "verbose stdin header"
        ? Buffer.from(
            stdout.toString("latin1").replace("==> 'standard input' <==", "==> standard input <=="),
            "latin1",
          )
        : stdout;
    assert.deepEqual(actual.stdout, expectedStdout);
    assert.equal(actual.stderr.length > 0, Buffer.from(expected.stderrBase64, "base64").length > 0);
  });
}

test("head stays absent until installed", { timeout: 10000 }, async (context) => {
  const actual = await run(context, "head", false);
  assert.equal(actual.status, 127);
  assert.equal(actual.stdout.length, 0);
});

test(
  "separate WASI head processes may read ahead on redirected stdin",
  { timeout: 10000 },
  async (context) => {
    const actual = await run(context, "printf 'one\\ntwo\\n' > f; { head -n1; head -n1; } < f");
    assert.equal(actual.status, 0);
    assert.equal(actual.stdout.toString(), "one\n");
  },
);

test(
  "repeated WASI stdin operands may discard buffered suffixes",
  { timeout: 10000 },
  async (context) => {
    const actual = await run(context, "printf 'one\\ntwo\\n' > f; head -q -n1 - - < f");
    assert.equal(actual.status, 0);
    assert.equal(actual.stdout.toString(), "one\n");
  },
);

test(
  "upstream help and version run through ordinary admission",
  { timeout: 10000 },
  async (context) => {
    const actual = await run(context, "head --help; head --version");
    assert.equal(actual.status, 0);
    assert.match(actual.stdout.toString(), /--lines/);
    assert.match(actual.stdout.toString(), /0\.12\.0/);
    assert.equal(actual.stderr.length, 0);
  },
);

test(
  "ordinary upstream head is interruptible while a producer stays open",
  { timeout: 10000 },
  async (context) => {
    const actual = await run(context, "while printf x; do :; done | head -n1", true, true);
    assert.equal(actual.status, 130);
    assert.equal(actual.stdout.length, 0);
  },
);
