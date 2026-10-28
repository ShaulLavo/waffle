import { createRuntime, type Runtime, type RuntimeSupervisor } from "waffle";
import { createWorkerProcessTransport, WorkerProcessClient, workerProcessState } from "waffle/proc/worker-client";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import { DescriptorTable } from "waffle/core/descriptors";
import { createPythonProgram, type PythonProgram } from "../src/index.ts";

interface Case {
  readonly script: string;
  readonly args: readonly string[];
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const cases: readonly Case[] = [
  { script: "script with spaces.py", args: ["", "two words", "β", "--flag"], status: 0,
    stdout: '["script with spaces.py", "", "two words", "β", "--flag"]\n', stderr: "" },
  { script: "stdlib.py", args: [], status: 0,
    stdout: '{"answer": 42, "square": 49}\nstdlib file written\n', stderr: "" },
  { script: "exit.py", args: [], status: 7, stdout: "out\n", stderr: "err\n" },
];
const sources: Record<string, string> = {
  "script with spaces.py": "import json, sys\nprint(json.dumps([sys.argv[0].rsplit('/', 1)[-1], *sys.argv[1:]], ensure_ascii=False))\n",
  "stdlib.py": "import json, math\nfrom pathlib import Path\nPath('created.json').write_text(json.dumps({'answer': 42, 'square': math.isqrt(2401)}))\nprint(Path('created.json').read_text())\nprint('stdlib file written')\n",
  "exit.py": "import sys\nprint('out')\nprint('err', file=sys.stderr)\nsys.exit(7)\n",
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function registerPreview1(runtime: Runtime, python: PythonProgram): () => void {
  const adapter = "python-package-test:preview1";
  const argv0: string[] = [python.argv0];
  const releaseAdapter = runtime.registerAdapter(adapter, (context, service) => service.launchWorker(context, {
    workerUrl: "/waffle-dist/browser/preview1-worker.js",
    request: {
      module: context.module,
      args: argv0.concat(context.request.argv.slice(1)),
      env: { ...context.request.env, PWD: context.request.cwd },
      interruptible: context.interruptible,
    },
  }));
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

function decode(chunks: Uint8Array[]): string {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(bytes);
}

async function runCase(client: WorkerProcessClient, supervisor: RuntimeSupervisor, rootPid: number, python: PythonProgram,
  example: Case, output: { stdout: Uint8Array[]; stderr: Uint8Array[] }) {
  output.stdout = [];
  output.stderr = [];
  const pid = client.spawn(rootPid, {
    executable: python.path,
    argv: [python.path, `/home/guest/${example.script}`].concat(example.args),
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LC_ALL: "C.UTF-8" },
    cwd: "/home/guest", job: 0, fds: [],
  });
  await supervisor.start(pid);
  const result = await supervisor.waitForExit(rootPid, pid);
  return { status: result.status, stdout: decode(output.stdout), stderr: decode(output.stderr) };
}

async function run() {
  const runtime = createRuntime({ filesystem: { workerURL: "/waffle-dist/browser/fs-worker.js", mode: "memory" } });
  const python = createPythonProgram(runtime, {
    wasmUrl: "/assets/python.wasm", payloadUrl: "/assets/python-stdlib.json",
  });
  const output = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
  let releaseRegistrations: (() => void) | undefined;
  try {
    await runtime.filesystem.mkdirp("/home/guest");
    await runtime.filesystem.mkdirp("/usr/bin");
    await runtime.filesystem.writeFile(python.path, new Uint8Array(), { exclusive: true });
    await runtime.filesystem.drain();
    for (const [name, source] of Object.entries(sources)) {
      await runtime.filesystem.writeFile(`/home/guest/${name}`, encoder.encode(source));
    }
    await runtime.filesystem.drain();
    releaseRegistrations = registerPreview1(runtime, python);
    const transport = createWorkerProcessTransport({
      pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer,
    });
    transport.data = { filesystem: runtime.filesystem.createIdentity() };
    const service = await runtime.processes();
    await service.adoptRuntimeRoot(transport, {
      output(fd, bytes) { (fd === 2 ? output.stderr : output.stdout).push(bytes.slice()); },
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
      const expected = { status: example.status, stdout: example.stdout, stderr: example.stderr };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ expected, actual }));
      results.push({ script: example.script, ...actual });
    }
    const created = decoder.decode(await runtime.filesystem.readFile("/home/guest/created.json"));
    if (created !== '{"answer": 42, "square": 49}') throw new Error(`Wrong created file: ${created}`);
    descriptors.dispose();
    releaseRegistrations();
    releaseRegistrations = undefined;
    await python.dispose();
    if (await runtime.filesystem.lookup("/Lib/os.py")) throw new Error("Owned stdlib survived disposal");
    return results;
  } finally {
    releaseRegistrations?.();
    await Promise.allSettled([python.dispose(), runtime.dispose()]);
  }
}

Object.assign(globalThis, { pythonPackageResult: run() });
