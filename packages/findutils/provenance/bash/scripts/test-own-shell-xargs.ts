import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  api,
  directory,
  nodeDirectory,
  prepareWaffleDirectories,
  readGuest,
  runRoot,
  shell,
  waffleFixture,
} from "./own-shell-waffle-fixture.ts";

const xargs = await readGuest("xargs.wasm");

async function fixture(context: TestContext) {
  const { runtime, setStop } = await waffleFixture(context);
  let loads = 0;
  await prepareWaffleDirectories(runtime, ["/tmp/spec", "/bin"]);
  const installation = await api.installXargs(runtime, {
    workerUrl: new URL("shell.mjs", nodeDirectory),
    source() {
      loads++;
      return xargs;
    },
  });
  await runtime.filesystem.drain();
  async function execute(script: string) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const options = {
      modulePath: "",
      tmp: "/tmp/spec",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      fixtureDirectory: directory,
    };
    const status = await runRoot(
      runtime,
      api,
      shell,
      options,
      script,
      (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
      setStop,
    );
    return {
      status,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  }
  return { execute, installation, runtime, loads: () => loads };
}

// Literal acceptance controls, not recorded GNU observations. Never invoke a host oracle.
const cases = [
  ["default whitespace", "printf 'a b\\nc' | xargs", "a b c\n"],
  ["quotes and escapes", "printf '%s\\n' '\"two words\" a\\ b' | xargs -n1", "two words\na b\n"],
  ["NUL records", "printf 'a b\\0c\\nd\\0' | xargs -0 -n1", "a b\nc\nd\n"],
  ["custom delimiter", "printf 'a b:c:d' | xargs -d: -n2", "a b c\nd\n"],
  ["line batches", "printf 'a b\\nc d\\n' | xargs -L1", "a b\nc d\n"],
  ["size batches", "printf 'a b c' | xargs -s9", "a b\nc\n"],
  ["empty input", "printf '' | xargs", "\n"],
  ["skip empty", "printf ' \\t\\n' | xargs -r", ""],
  ["EOF marker", "printf 'a STOP b' | xargs -E STOP", "a\n"],
  ["relative input file", "printf 'a b c' > args; xargs -a args -n2", "a b\nc\n"],
] as const;

for (const [label, script, expected] of cases) {
  test(`xargs ${label} in Waffle`, { timeout: 10000 }, async (context) => {
    const state = await fixture(context);
    const result = await state.execute(script);
    assert.deepEqual(result, { status: 0, stdout: expected, stderr: "" });
  });
}

test(
  "xargs loads once on first use and releases only its own registration",
  { timeout: 10000 },
  async (context) => {
    const state = await fixture(context);
    assert.equal(state.loads(), 0);
    assert.equal((await state.execute("printf a | xargs")).stdout, "a\n");
    assert.equal((await state.execute("printf b | xargs")).stdout, "b\n");
    assert.equal(state.loads(), 1);
    await state.installation.dispose();
    assert.equal((await state.execute("xargs")).status, 127);
    assert.equal(await state.runtime.filesystem.lookup("/bin/xargs"), undefined);
    assert.equal(state.runtime.disposed, false);
  },
);

for (const command of [
  "xargs echo",
  "xargs -r echo",
  "xargs -- /bin/echo",
  "xargs -a missing echo",
]) {
  test(`xargs gates ${command}`, { timeout: 10000 }, async (context) => {
    const state = await fixture(context);
    const result = await state.execute(command);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /runtime_proc.spawn\/wait/);
    assert.doesNotMatch(result.stderr, /Failed to open/);
  });
}

test(
  "xargs rejects parallel and replacement modes and malformed input",
  { timeout: 10000 },
  async (context) => {
    const state = await fixture(context);
    for (const script of ["xargs -P2", "xargs -I{}", "printf '%s' '\"unterminated' | xargs"]) {
      const result = await state.execute(script);
      assert.equal(result.status, 1, script);
      assert.equal(result.stdout, "", script);
      assert.notEqual(result.stderr, "", script);
    }
  },
);

test(
  "xargs reports a closed downstream output without panicking",
  { timeout: 10000 },
  async (context) => {
    const state = await fixture(context);
    const input = `${"a".repeat(256)}\n`.repeat(1024);
    await state.runtime.filesystem.writeFile(
      "/tmp/spec/closed-output-args",
      new TextEncoder().encode(input),
    );
    await state.runtime.filesystem.drain();
    const result = await state.execute(
      "set -o pipefail; printf '' | xargs -a closed-output-args -n1 | { read -r; exit 0; }; printf 'STATUS:%s:%s\\n' \"$?\" \"${PIPESTATUS[*]}\"",
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /STATUS:1:0 1 0\n$/);
    assert.match(result.stderr, /Command output failed/);
    assert.doesNotMatch(result.stderr, /panicked at|panic/);
  },
);
