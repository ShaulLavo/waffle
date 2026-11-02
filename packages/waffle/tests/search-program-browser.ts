import {
  createRuntime,
  type GuestLauncher,
  type Runtime,
  type RuntimeProcessContext,
} from "../runtime.js";
import { FilesystemClient } from "../fs/client.js";
import { installPrograms, type ProgramPackage } from "../programs/index.js";
import { fastRipgrep } from "../../ripgrep/src/index.js";
import { fastGrep } from "../../grep/src/index.js";
import { createProgramTestRoot } from "../../../tools/program-test-root.js";

interface Vector {
  readonly tool: "rg" | "grep";
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly pipe?: boolean;
  readonly expected: { readonly stdout: string; readonly stderr: string; readonly status: number };
}
interface Observation {
  readonly pid: number;
  readonly module: WebAssembly.Module;
  readonly context: RuntimeProcessContext;
  fallback: boolean;
  transport: boolean;
}
const workers = { search: "/search-worker.js", shard: "/shard-worker.js" };
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

interface FrozenExpected {
  readonly arguments: string[];
  readonly exitCode: number;
  readonly outputBytes: number;
  readonly outputLines: number;
  readonly canonicalStdoutSha256: string;
}
interface FrozenManifest {
  readonly corpus: { readonly regularFiles: number; readonly bytes: number };
  readonly workloads: readonly {
    readonly name: string;
    readonly rg: FrozenExpected;
    readonly grep: FrozenExpected;
  }[];
}

async function frozenCases(
  runtime: Runtime,
  root: Awaited<ReturnType<typeof createProgramTestRoot>>,
  resources: () => Promise<Record<string, number>>,
  admitted: () => boolean,
) {
  const response = await fetch("/frozen/manifest.json");
  if (!response.ok) return null;
  const manifest: FrozenManifest = await response.json();
  const census: {
    readonly files: readonly {
      readonly path: string;
      readonly bytes: number;
      readonly offset: number;
    }[];
  } = await (await fetch("/frozen/census.json")).json();
  const payload = new Uint8Array(await (await fetch("/frozen/payload.bin")).arrayBuffer());
  check(
    census.files.length === manifest.corpus.regularFiles &&
      payload.length === manifest.corpus.bytes,
    "frozen corpus size mismatch",
  );
  const directories = new Set(
    census.files.map((file) => `/corpus/${file.path.slice(0, file.path.lastIndexOf("/") + 1)}`),
  );
  for (const directory of directories) await runtime.filesystem.mkdirp(directory);
  for (let at = 0; at < census.files.length; at += 32)
    await Promise.all(
      census.files
        .slice(at, at + 32)
        .map((file) =>
          runtime.filesystem.writeFile(
            `/corpus/${file.path}`,
            payload.subarray(file.offset, file.offset + file.bytes),
          ),
        ),
    );
  const rows: {
    tool: string;
    workload: string;
    status: number;
    outputBytes: number;
    outputLines: number;
    canonicalStdoutSha256: string;
  }[] = [];
  const encoder = new TextEncoder();
  for (const workload of manifest.workloads) {
    for (const tool of ["rg", "grep"] as const) {
      const expected = workload[tool];
      const result = await root.exec({
        executable: `/usr/bin/${tool}`,
        argv: Array<string>(tool).concat(expected.arguments),
        env: { LC_ALL: "C.UTF-8", PWD: "/corpus" },
        cwd: "/corpus",
      });
      check(admitted(), `${tool} frozen vector fell back`);
      const lines = result.stdout.split("\n").filter(Boolean);
      const sorted = lines.toSorted();
      const bytes = encoder.encode(sorted.length ? `${sorted.join("\n")}\n` : "");
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      check(
        result.status === expected.exitCode && result.stderr === "",
        `${tool} ${workload.name} exit/stderr mismatch ${result.status} ${result.stderr}`,
      );
      check(
        encoder.encode(result.stdout).length === expected.outputBytes &&
          lines.length === expected.outputLines &&
          digest === expected.canonicalStdoutSha256,
        `${tool} ${workload.name} frozen output mismatch`,
      );
      const after = await resources();
      check(
        after.walks === 0 && after.walkGrants === 0,
        `${tool} ${workload.name} retained walk resources`,
      );
      rows.push({
        tool,
        workload: workload.name,
        status: result.status,
        outputBytes: expected.outputBytes,
        outputLines: lines.length,
        canonicalStdoutSha256: digest,
      });
    }
  }
  return rows;
}

/** @browserEntry */
export async function searchProgramBrowserCases() {
  const live = new Set<Worker>();
  const NativeWorker = globalThis.Worker;
  let fsWorker: Worker | undefined;
  function remember(worker: Worker, url: string | URL): void {
    live.add(worker);
    if (String(url) === "/fs-worker.js") fsWorker = worker;
  }
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      remember(this, url);
    }
    override postMessage(
      message: unknown,
      transfer: Transferable[] | StructuredSerializeOptions = [],
    ): void {
      if (
        message &&
        typeof message === "object" &&
        "runtimeProcess" in message &&
        "module" in message
      )
        verifyTransport(message);
      if (Array.isArray(transfer)) super.postMessage(message, transfer);
      else super.postMessage(message, transfer);
    }
    override terminate() {
      live.delete(this);
      super.terminate();
    }
  };
  const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });
  const observations: Observation[] = [];
  function verifyTransport(message: {
    readonly runtimeProcess: unknown;
    readonly module: unknown;
  }): void {
    const process = message.runtimeProcess;
    const observed = observations.at(-1);
    check(
      observed && process && typeof process === "object" && "pid" in process && "cwd" in process,
      "missing process transport",
    );
    check(
      process.pid === observed.pid && process.cwd === observed.context.request.cwd,
      "worker pid/cwd changed",
    );
    check(message.module === observed.module, "worker module identity changed");
    check(
      "env" in message &&
        message.env === observed.context.request.env &&
        "args" in message &&
        message.args === observed.context.request.argv,
      "worker args/environment changed",
    );
    observed.transport = true;
  }
  const fallback: GuestLauncher = (context, service) => {
    const observed = observations.at(-1);
    check(observed?.context === context, "fallback changed launch context");
    observed.fallback = true;
    return service.launchWorker(context, {
      workerUrl: "/preview1-worker.js",
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    });
  };
  function observe(pkg: ProgramPackage): ProgramPackage {
    return {
      ...pkg,
      programs: pkg.programs.map((program) =>
        program.command
          ? program
          : {
              ...program,
              launch: async (context, service, original) => {
                observations.push({
                  pid: context.pid,
                  module: context.module,
                  context,
                  fallback: false,
                  transport: false,
                });
                check(context.module instanceof WebAssembly.Module, "real module was not admitted");
                check(program.launch, "missing opt-in launch hook");
                return program.launch(context, service, original);
              },
            },
      ),
    };
  }
  let queryId = 0;
  async function resources(): Promise<Record<string, number>> {
    const worker = fsWorker;
    check(worker, "no filesystem worker");
    const id = ++queryId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (event: MessageEvent) => void = () => {};
    try {
      return await new Promise<Record<string, number>>((resolve, reject) => {
        listener = ({ data }) => {
          if (data?.type === "search-resources" && data.id === id) resolve(data.resources);
        };
        worker.addEventListener("message", listener);
        timer = setTimeout(() => reject(new Error("resource query timed out")), 10000);
        worker.postMessage({ resources: id });
      });
    } finally {
      clearTimeout(timer);
      worker.removeEventListener("message", listener);
    }
  }
  const admin = new FilesystemClient(
    runtime.filesystem.connect(runtime.filesystem.createIdentity()),
  );
  let installation: Awaited<ReturnType<typeof installPrograms>> | undefined;
  let root: Awaited<ReturnType<typeof createProgramTestRoot>> | undefined;
  try {
    installation = await installPrograms(
      runtime,
      [observe(fastRipgrep(workers, { stdoutIsTTY: false })), observe(fastGrep(workers))],
      { launcher: fallback },
    );
    root = await createProgramTestRoot(runtime);
    const files: Record<string, string> = {
      "a.txt": "needle\nOther Needle\nlast needle",
      "empty.txt": "",
      "plain.txt": "absent\n",
      "sub/b.txt": "needle\n",
      "skip/c.txt": "needle\n",
      ".hidden.txt": "needle\n",
    };
    await runtime.filesystem.mkdirp("/fixture/sub");
    await runtime.filesystem.mkdirp("/fixture/skip");
    for (const [path, text] of Object.entries(files))
      await runtime.filesystem.writeFile(`/fixture/${path}`, new TextEncoder().encode(text));
    const adminRoot = await admin.asyncCall("preopen", ["/"]);
    for (const [path, target] of [
      ["file-link", "a.txt"],
      ["dir-link", "sub"],
    ]) {
      const resolved = await admin.asyncCall("resolve", [adminRoot, `fixture/${path}`, false]);
      check((await admin.asyncCall("symlink", [resolved, target])) === 0, "symlink setup failed");
    }
    const vectors: readonly Vector[] = await (await fetch("/vectors.json")).json();
    const passed: { tool: string; argv: string[]; fallback: boolean; pid: number }[] = [];
    for (const vector of vectors) {
      const request = {
        executable: `/usr/bin/${vector.tool}`,
        argv: Array<string>(vector.tool).concat(vector.argv),
        env: vector.env,
        cwd: "/fixture",
      };
      const result = vector.pipe ? await root.execPipe(request) : await root.exec(request);
      const observed = observations.at(-1)!;
      check(observed.transport, "launch did not use the real process transport");
      const canonical = (text: string) => text.split("\n").filter(Boolean).sort().join("\n");
      check(
        result.status === vector.expected.status,
        `${vector.tool} ${vector.argv}: status ${result.status}, stderr ${result.stderr}`,
      );
      check(
        canonical(result.stdout) === canonical(vector.expected.stdout),
        `${vector.tool} ${vector.argv}: stdout ${JSON.stringify(result.stdout)}, expected ${JSON.stringify(vector.expected.stdout)}`,
      );
      check(
        result.stderr === vector.expected.stderr,
        `${vector.tool} ${vector.argv}: stderr ${JSON.stringify(result.stderr)}`,
      );
      passed.push({
        tool: vector.tool,
        argv: vector.argv,
        fallback: observed.fallback,
        pid: observed.pid,
      });
    }
    check(
      passed.some((result) => result.fallback),
      "no real fallback invocation ran",
    );
    check(
      passed.some((result) => !result.fallback && result.tool === "rg"),
      "no fast rg invocation ran",
    );
    check(
      passed.some((result) => !result.fallback && result.tool === "grep"),
      "no fast grep invocation ran",
    );
    const frozen = await frozenCases(
      runtime,
      root,
      resources,
      () => observations.at(-1)?.fallback === false,
    );
    await runtime.filesystem.writeFile("/fixture/large.txt", "needle\n".repeat(65536));
    const streaming = {
      executable: "/usr/bin/rg",
      argv: ["rg", "--color", "never", "--no-ignore", "--hidden", "--text", "-nF", "needle", "."],
      env: { LC_ALL: "C", PWD: "/fixture" },
      cwd: "/fixture",
    };
    const head = await root.execPipe(streaming, { kind: "head" });
    check(head.status === 141, `head exit ${head.status}: ${head.stderr}`);
    const interrupted = await root.execPipe(streaming, { kind: "signal", signal: 2 });
    check(interrupted.status === 130, `SIGINT exit ${interrupted.status}: ${interrupted.stderr}`);
    await installation.dispose();
    installation = await installPrograms(
      runtime,
      [observe(fastGrep({ ...workers, shard: "/fault-shard.js?mode=lose-batch" }))],
      { launcher: fallback },
    );
    const before = await resources();
    const fault = await root.exec({
      executable: "/usr/bin/grep",
      argv: ["grep", "-racF", "needle", "."],
      env: { LC_ALL: "C", PWD: "/fixture" },
      cwd: "/fixture",
    });
    check(!observations.at(-1)?.fallback, "fault case unexpectedly used WASM fallback");
    check(fault.status === 1, `failed helper status ${fault.status}`);
    const after = await resources();
    for (const field of ["walks", "walkGrants", "responses"])
      check(after[field] === 0, `fenced helper retained ${field}: ${after[field]}`);
    for (const field of ["clients", "retained", "transient"])
      check(
        after[field] === before[field],
        `fenced helper changed ${field}: ${before[field]} to ${after[field]}`,
      );
    return {
      vectors: passed,
      frozen,
      pipe: head.status,
      interrupt: interrupted.status,
      fencedFault: { status: fault.status, before, after },
    };
  } finally {
    admin.dispose();
    await root?.dispose();
    await installation?.dispose();
    await runtime.dispose();
    globalThis.Worker = NativeWorker;
    check(live.size === 0, `${live.size} program workers leaked`);
  }
}
