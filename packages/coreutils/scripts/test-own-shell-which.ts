import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";
import { runRoot } from "./waffle-compat.ts";
import * as replay from "./test-own-shell-wasi-fixture.ts";

const { api, directory, nodeDirectory } = replay;
const shell = await replay.readShell();
const which = await replay.readWasiSource("which");

async function fixture(context: TestContext) {
  let stop = () => {};
  let runtime: ReturnType<typeof api.createRuntime> | undefined;
  context.after(async () => {
    stop();
    try {
      await runtime?.dispose();
    } finally {
      await stopNodeWorkers();
      assert.equal(liveNodeWorkers(), 0);
    }
  });
  installNodeWorkers();
  const owner = api.createRuntime({
    filesystem: { workerURL: new URL("fs.mjs", nodeDirectory), mode: "memory" },
  });
  runtime = owner;
  for (const path of ["/tmp/spec/local", "/bin", "/first", "/second", "/bin/directory"])
    await owner.filesystem.mkdirp(path);
  owner.registerAdapter("unlaunched-candidate", () => {
    throw new Error("which must not launch candidates");
  });
  let candidateLoads = 0;
  const registers = [];
  for (const path of [
    "/first/tool",
    "/second/tool",
    "/tmp/spec/tool",
    "/tmp/spec/local/tool",
    "/bin/-tool",
  ]) {
    await owner.filesystem.writeFile(path, new Uint8Array());
    registers.push(
      owner.registerProgram(path, {
        adapter: "unlaunched-candidate",
        source: () => {
          candidateLoads++;
          throw new Error("which must not load candidates");
        },
      }),
    );
  }
  await owner.filesystem.writeFile("/bin/plain", new TextEncoder().encode("not a program\n"));
  await owner.filesystem.writeFile(
    "/bin/stale",
    new TextEncoder().encode("bash-web utility: stale\n"),
  );
  let whichLoads = 0;
  const install = () =>
    api.installWhich(owner, {
      workerUrl: new URL("shell.mjs", nodeDirectory),
      source: () => {
        whichLoads++;
        return which;
      },
    });
  await owner.filesystem.drain();
  async function execute(
    script: string,
    env: Record<string, string> = { PATH: "/bin:/first:/second" },
  ) {
    const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    const status = await runRoot(
      owner,
      api,
      shell,
      { modulePath: "", tmp: "/tmp/spec", env, fixtureDirectory: directory },
      script,
      (fd, bytes) => output[fd === 2 ? "stderr" : "stdout"].push(Buffer.from(bytes)),
      (terminate) => {
        stop = terminate;
      },
    );
    assert.equal(candidateLoads, 0, "metadata lookup must not load, compile or launch candidates");
    return {
      status,
      stdout: Buffer.concat(output.stdout).toString(),
      stderr: Buffer.concat(output.stderr).toString(),
    };
  }
  return { execute, install, owner, registers, loads: () => whichLoads };
}

const cases = [
  { name: "first registered match", script: "which tool", status: 0, stdout: "/first/tool\n" },
  {
    name: "all matches",
    script: "which --all tool",
    status: 0,
    stdout: "/first/tool\n/second/tool\n",
  },
  {
    name: "files, stale markers, directories, and builtins are not programs",
    script: "which plain stale directory printf",
    status: 1,
    stdout: "",
  },
  {
    name: "missing operand does not suppress later successes",
    script: "which missing tool",
    status: 1,
    stdout: "/first/tool\n",
  },
  {
    name: "direct paths bypass PATH",
    script: "which ./tool /second/tool",
    status: 0,
    stdout: "/tmp/spec/tool\n/second/tool\n",
  },
  {
    name: "non-directory traversal cannot cancel lexically",
    script: "which /bin/plain/../../first/tool",
    status: 1,
    stdout: "",
  },
  {
    name: "empty PATH entry searches cwd",
    script: "PATH=:/first /bin/which tool",
    status: 0,
    stdout: "/tmp/spec/tool\n",
  },
  {
    name: "relative PATH entry searches cwd",
    script: "PATH=local:/first /bin/which tool",
    status: 0,
    stdout: "/tmp/spec/local/tool\n",
  },
  {
    name: "unset PATH searches nowhere",
    script: "unset PATH; /bin/which tool",
    status: 1,
    stdout: "",
  },
  { name: "option terminator", script: "which -- -tool", status: 0, stdout: "/bin/-tool\n" },
] as const;

for (const expected of cases) {
  test(`ordinary WASI which: ${expected.name}`, { timeout: 15000 }, async (context) => {
    const state = await fixture(context);
    const installation = await state.install();
    const actual = await state.execute(expected.script);
    assert.deepEqual(actual, { status: expected.status, stdout: expected.stdout, stderr: "" });
    assert.equal(state.loads(), 1);
    await installation.dispose();
  });
}

test(
  "which stays lazy, observes unregister and missing entries, and disposes independently",
  { timeout: 15000 },
  async (context) => {
    const state = await fixture(context);
    assert.equal((await state.execute("which tool")).status, 127);
    const installation = await state.install();
    assert.equal(state.loads(), 0);
    assert.equal((await state.execute("which tool")).stdout, "/first/tool\n");
    state.registers[0]();
    assert.equal((await state.execute("which -a tool")).stdout, "/second/tool\n");
    await state.owner.filesystem.remove("/second/tool");
    await state.owner.filesystem.drain();
    assert.equal((await state.execute("which tool")).status, 1);
    assert.equal(state.loads(), 1);
    await installation.dispose();
    assert.equal((await state.execute("which tool")).status, 127);
    assert.equal(state.owner.disposed, false);
  },
);

test(
  "which reports unsupported options and missing names without querying candidates",
  { timeout: 15000 },
  async (context) => {
    const state = await fixture(context);
    await state.install();
    for (const script of ["which", "which -a", "which --skip-alias tool"]) {
      const result = await state.execute(script);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^which: /);
    }
  },
);
