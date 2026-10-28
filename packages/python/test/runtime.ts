import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createRuntime, type Runtime } from "waffle";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState } from "waffle/proc/worker-client";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import { DescriptorTable } from "waffle/core/descriptors";
import type { RuntimeSupervisor } from "waffle";
import { createPythonProgram, PYTHON_ARGV0, type PythonProgram } from "../src/index.ts";
import { serveTestFiles, type TestServer } from "./assets-server.ts";
import { installNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";

const root = resolve(import.meta.dirname, "..");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Case {
  readonly script: string;
  readonly args: readonly string[];
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const cases: readonly Case[] = [
  {
    script: "script with spaces.py",
    args: ["", "two words", "β", "--flag"],
    status: 0,
    stdout: '["script with spaces.py", "", "two words", "β", "--flag"]\n',
    stderr: "",
  },
  {
    script: "stdlib.py",
    args: [],
    status: 0,
    stdout: '{"answer": 42, "square": 49}\nstdlib file written\n',
    stderr: "",
  },
  {
    script: "exit.py",
    args: [],
    status: 7,
    stdout: "out\n",
    stderr: "err\n",
  },
];

const sources: Record<string, string> = {
  "script with spaces.py": "import json, sys\nprint(json.dumps([sys.argv[0].rsplit('/', 1)[-1], *sys.argv[1:]], ensure_ascii=False))\n",
  "stdlib.py": "import json, math\nfrom pathlib import Path\nPath('created.json').write_text(json.dumps({'answer': 42, 'square': math.isqrt(2401)}))\nprint(Path('created.json').read_text())\nprint('stdlib file written')\n",
  "exit.py": "import sys\nprint('out')\nprint('err', file=sys.stderr)\nsys.exit(7)\n",
};

function registerPreview1(runtime: Runtime, python: PythonProgram, workerUrl: string): () => void {
  const adapter = "python-package-test:preview1";
  const argv0: string[] = [python.argv0];
  const releaseAdapter = runtime.registerAdapter(adapter, (context, service) => {
    service.registerController(context.pid, {
      startFailed(error) { console.error("Python process start failed:", error); },
      wake() {},
    });
    return service.launchWorker(context, {
      workerUrl,
      request: {
        module: context.module,
        args: argv0.concat(context.request.argv.slice(1)),
        env: { ...context.request.env, PWD: context.request.cwd },
        interruptible: context.interruptible,
      },
    });
  });
  let releaseProgram: (() => void) | undefined;
  try {
    releaseProgram = runtime.registerProgram(python.path, { adapter, source: python.source });
  } catch (error) {
    releaseAdapter();
    throw error;
  }
  return () => {
    releaseProgram?.();
    releaseAdapter();
  };
}

async function assertExclusiveCreate(runtime: Runtime): Promise<void> {
  const path = "/home/guest/exclusive-race.txt";
  const results = await Promise.allSettled([
    runtime.filesystem.writeFile(path, "first", { exclusive: true }),
    runtime.filesystem.writeFile(path, "second", { exclusive: true }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const drainedFailure = await runtime.filesystem.drain().then(() => false, () => true);
  assert.equal(drainedFailure, true);
  const bytes = await runtime.filesystem.readFile(path);
  assert.ok(bytes);
  const value = new TextDecoder().decode(bytes);
  assert.ok(value === "first" || value === "second");
  await runtime.filesystem.remove(path);
}

async function runCase(
  client: WorkerProcessClient,
  supervisor: RuntimeSupervisor,
  rootPid: number,
  python: PythonProgram,
  example: Case,
  output: { stdout: Buffer[]; stderr: Buffer[] },
) {
  output.stdout = [];
  output.stderr = [];
  const pid = client.spawn(rootPid, {
    executable: python.path,
    argv: [python.path, `/home/guest/${example.script}`].concat(example.args),
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LC_ALL: "C.UTF-8" },
    cwd: "/home/guest",
    job: 0,
    fds: [],
  });
  await supervisor.start(pid);
  const result = await supervisor.waitForExit(rootPid, pid);
  return {
    status: result.status,
    stdout: Buffer.concat(output.stdout).toString("utf8"),
    stderr: Buffer.concat(output.stderr).toString("utf8"),
  };
}

async function run(server: TestServer): Promise<void> {
  installNodeWorkers();
  const runtime = createRuntime({
    filesystem: {
      workerURL: new URL("../node_modules/waffle/dist/browser/fs-worker.js", import.meta.url),
      mode: "memory",
    },
  });
  const python = createPythonProgram(runtime, {
    wasmUrl: `${server.origin}/assets/python.wasm`,
    payloadUrl: `${server.origin}/assets/python-stdlib.json`,
  });
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let releaseRegistrations: (() => void) | undefined;
  try {
    assert.equal(python.argv0, PYTHON_ARGV0);
    await runtime.filesystem.mkdirp("/home/guest");
    await assertExclusiveCreate(runtime);
    await runtime.filesystem.mkdirp("/usr/bin");
    await runtime.filesystem.writeFile(python.path, new Uint8Array(), { exclusive: true });
    await runtime.filesystem.drain();
    for (const [name, source] of Object.entries(sources)) {
      await runtime.filesystem.writeFile(`/home/guest/${name}`, encoder.encode(source));
    }
    await runtime.filesystem.drain();
    releaseRegistrations = registerPreview1(runtime, python, new URL("../node_modules/waffle/dist/browser/preview1-worker.js", import.meta.url).href);
    const transport = createWorkerProcessTransport({
      pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer,
    });
    transport.data = { filesystem: runtime.filesystem.createIdentity() };
    const service = await runtime.processes();
    await service.adoptRuntimeRoot(transport, {
      output(fd, bytes) { (fd === 2 ? output.stderr : output.stdout).push(Buffer.from(bytes)); },
    });
    const supervisor = await service.ready();
    const rootPid = workerProcessState(transport).pid;
    const descriptors = new DescriptorTable();
    const pipeHost = new WorkerPipeHost({
      transport,
      postMessage(message) { void service.runtimeMessage(message, rootPid); },
    });
    const client = new WorkerProcessClient({
      transport,
      descriptors,
      codec: pipeHost.codec(),
      postMessage(message) { void service.runtimeMessage(message, rootPid); },
      prepareSpawn: () => ({ data: { filesystem: runtime.filesystem.createIdentity() } }),
    });
    const results = [];
    for (const example of cases) {
      const actual = await runCase(client, supervisor, rootPid, python, example, output);
      assert.deepEqual(actual, { status: example.status, stdout: example.stdout, stderr: example.stderr });
      results.push({ script: example.script, ...actual });
      console.log(JSON.stringify(results.at(-1)));
    }
    assert.equal(decoder.decode(await runtime.filesystem.readFile("/home/guest/created.json")), '{"answer": 42, "square": 49}');
    descriptors.dispose();
    releaseRegistrations();
    releaseRegistrations = undefined;
    await python.dispose();
    assert.equal(await runtime.filesystem.lookup("/Lib/os.py"), undefined);
  } finally {
    releaseRegistrations?.();
    await Promise.allSettled([python.dispose(), runtime.dispose()]);
    await stopNodeWorkers();
  }
}

const server = await serveTestFiles(root);
try {
  await run(server);
} finally {
  await server.close();
}
