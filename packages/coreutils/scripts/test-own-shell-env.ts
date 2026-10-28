import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import {
  api,
  directory,
  nodeDirectory,
  readShell,
  readWasiSource,
} from "./test-own-shell-wasi-fixture.ts";

const source = await readWasiSource("env");
const guest = await WebAssembly.compile(source);

// These are literal source-contract expectations, not observations from a host oracle.
function printEnv(args: string[], env: Record<string, string> = {}) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const wasi = new api.Wasi({
    args: ["env"].concat(args),
    env,
    fs: new api.MemFS(),
    preopens: { "/": "/" },
    sleep() {
      throw new Error("print-only env must not block");
    },
    stdout: (bytes) => stdout.push(Buffer.from(bytes)),
    stderr: (bytes) => stderr.push(Buffer.from(bytes)),
  });
  try {
    const imports = wasi.imports(guest);
    const instance = new WebAssembly.Instance(guest, imports);
    const status = wasi.start(instance);
    return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    wasi.descriptors.dispose();
  }
}

const cases: { name: string; args: string[]; env: Record<string, string>; stdout: string }[] = [
  { name: "empty environment", args: [], env: {}, stdout: "" },
  {
    name: "ordered unset and repeated assignments",
    args: ["-u", "A", "-u", "MISSING", "A=first", "A=last", "C=x=y"],
    env: { A: "old", B: "keep" },
    stdout: "B=keep\nA=last\nC=x=y\n",
  },
  {
    name: "dash clears and preserves unusual assignment names",
    args: ["-", "--odd=value", "EMPTY="],
    env: { OLD: "gone" },
    stdout: "--odd=value\nEMPTY=\n",
  },
  {
    name: "option terminator permits dash assignment",
    args: ["-i", "--", "-name=value"],
    env: {},
    stdout: "-name=value\n",
  },
  {
    name: "NUL separates values containing newlines",
    args: ["-i", "-0", "A=line\nbreak", "B=two words"],
    env: {},
    stdout: "A=line\nbreak\0B=two words\0",
  },
  {
    name: "split escapes single quotes and comments",
    args: ["-i", "-S", "A=\"one\\_two\" B='${BASE}' # comment"],
    env: { BASE: "expanded" },
    stdout: "A=one two\nB=${BASE}\n",
  },
  {
    name: "inherited environment",
    args: [],
    env: { A: "old", B: "keep" },
    stdout: "A=old\nB=keep\n",
  },
  {
    name: "ignore inherited and assign",
    args: ["-i", "A=one", "B=two"],
    env: { OLD: "gone" },
    stdout: "A=one\nB=two\n",
  },
  { name: "NUL records", args: ["-i", "-0", "A=one", "B=two"], env: {}, stdout: "A=one\0B=two\0" },
  {
    name: "unset inherited name",
    args: ["-u", "A"],
    env: { A: "old", B: "keep" },
    stdout: "B=keep\n",
  },
  {
    name: "repeated unset",
    args: ["-u", "A", "-u", "B"],
    env: { A: "old", B: "keep" },
    stdout: "",
  },
  {
    name: "assignment after unset",
    args: ["-u", "A", "A=new"],
    env: { A: "old" },
    stdout: "A=new\n",
  },
  {
    name: "quoted split assignments",
    args: ["-i", "-S", 'A=one B="two words"'],
    env: {},
    stdout: "A=one\nB=two words\n",
  },
  {
    name: "split expands inherited value before ignore",
    args: ["-i", "-S", "A=pre${BASE}post"],
    env: { BASE: "middle" },
    stdout: "A=premiddlepost\n",
  },
  {
    name: "long options and empty value",
    args: ["--ignore-environment", "--null", "--split-string=A= B=two"],
    env: { OLD: "gone" },
    stdout: "A=\0B=two\0",
  },
];

for (const example of cases) {
  test(`env print-only contract: ${example.name}`, () => {
    const actual = printEnv(example.args, example.env);
    assert.equal(actual.status, 0, actual.stderr.toString());
    assert.deepEqual(actual.stdout, Buffer.from(example.stdout));
    assert.equal(actual.stderr.length, 0);
  });
}

for (const args of [
  ["-C", "/"],
  ["-0", "echo"],
  ["-u", "bad=name"],
  ["-S", "A=one\\q"],
  ["-S", "A=$BASE"],
]) {
  test(`env local usage error: ${args.join(" ")}`, () => {
    const actual = printEnv(args);
    assert.equal(actual.status, 125);
    assert.equal(actual.stdout.length, 0);
    assert.ok(actual.stderr.length > 0);
  });
}

test("env input debug output does not alter printed bytes", () => {
  const actual = printEnv(["-vv", "-i", "A=one"], { A: "old" });
  assert.equal(actual.status, 0);
  assert.deepEqual(actual.stdout, Buffer.from("A=one\n"));
  assert.ok(actual.stderr.length > 0);
});

test("env unsupported command modes reject before process imports or input", () => {
  assert.ok(
    WebAssembly.Module.imports(guest).every((entry) => entry.module === "wasi_snapshot_preview1"),
  );
  for (const args of [
    ["-i", "env"],
    ["env"],
    ["-C", "/", "env"],
    ["-a", "custom", "env"],
    ["-S", "A=one env"],
    ["-u", "PWD", "env"],
    ["PWD=/different", "env"],
    ["-C", "/tmp", "env"],
    ["--ignore-signal=INT", "env"],
    ["--default-signal", "env"],
    ["--block-signal=PIPE", "env"],
    ["--list-signal-handling", "env"],
    ["-S", "--ignore-signal=INT env"],
  ]) {
    const actual = printEnv(args, { PWD: "/" });
    assert.equal(actual.status, 125, actual.stderr.toString());
    assert.equal(actual.stdout.length, 0);
    assert.ok(actual.stderr.length > 0);
  }
});

async function installedFixture(context: TestContext, cwd = "/tmp/spec") {
  installNodeWorkers();
  const runtime = api.createRuntime({
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
  });
  const stops: (() => void)[] = [];
  context.after(async () => {
    for (const stop of stops) stop();
    try {
      await runtime.dispose();
    } finally {
      await stopNodeWorkers();
      assert.equal(liveNodeWorkers(), 0);
    }
  });
  for (const path of ["/tmp/spec", "/bin"]) await runtime.filesystem.mkdirp(path);
  const shell = await readShell();
  async function run(script: string) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const status = await runRoot(
      runtime,
      api,
      shell,
      {
        modulePath: "",
        tmp: cwd,
        env: { PATH: "/bin", A: "old" },
        fixtureDirectory: directory,
      },
      script,
      (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
      (stop) => stops.push(stop),
    );
    return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  }
  return { runtime, run };
}

test(
  "env installs lazily, edits only its guest and disposes without closing the borrowed runtime",
  { timeout: 20000 },
  async (context) => {
    const { runtime, run } = await installedFixture(context);
    assert.equal((await run("env")).status, 127);
    let loads = 0;
    const workersBefore = liveNodeWorkers();
    const installation = await api.installEnv(runtime, {
      workerUrl: new URL("shell.mjs", nodeDirectory),
      source: () => {
        loads++;
        return source;
      },
    });
    assert.equal(loads, 0);
    assert.equal(liveNodeWorkers(), workersBefore);
    assert.equal(installation.executable, "/bin/env");
    const actual = await run('env -i A=one; env -i -0 B=two; printf "parent:%s\\n" "$A"');
    assert.equal(actual.status, 0, actual.stderr.toString());
    assert.deepEqual(actual.stdout, Buffer.from("A=one\nB=two\0parent:old\n"));
    assert.equal(actual.stderr.length, 0);
    assert.equal(loads, 1);
    await installation.dispose();
    assert.equal(await runtime.filesystem.lookup("/bin/env"), undefined);
    assert.equal(runtime.disposed, false);
    assert.equal((await run("env")).status, 127);
  },
);
