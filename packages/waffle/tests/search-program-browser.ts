import { createRuntime, type GuestLauncher, type RuntimeProcessContext } from "../runtime.js";
import { FilesystemClient } from "../fs/client.js";
import { installPrograms, type ProgramPackage } from "../programs/index.js";
import { fastRipgrep } from "../../ripgrep/src/index.js";
import { fastGrep } from "../../grep/src/index.js";
import { createProgramTestRoot } from "../../../tools/program-test-root.js";

interface Vector {
  readonly tool: "rg" | "grep";
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly expected: { readonly stdout: string; readonly stderr: string; readonly status: number };
}
interface Observation {
  readonly pid: number;
  readonly module: WebAssembly.Module;
  readonly context: RuntimeProcessContext;
  fallback: boolean;
}
const workers = { search: "/search-worker.js", shard: "/shard-worker.js" };
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** @browserEntry */
export async function searchProgramBrowserCases() {
  const live = new Set<Worker>();
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      live.add(this);
    }
    override terminate() {
      live.delete(this);
      super.terminate();
    }
  };
  const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });
  const observations: Observation[] = [];
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
      programs: pkg.programs.map((program) => ({
        ...program,
        launch: async (context, service, original) => {
          observations.push({ pid: context.pid, module: context.module, context, fallback: false });
          check(context.module instanceof WebAssembly.Module, "real module was not admitted");
          check(program.launch, "missing opt-in launch hook");
          return program.launch(context, service, original);
        },
      })),
    };
  }
  const admin = new FilesystemClient(
    runtime.filesystem.connect(runtime.filesystem.createIdentity()),
  );
  let installation: Awaited<ReturnType<typeof installPrograms>> | undefined;
  let root: Awaited<ReturnType<typeof createProgramTestRoot>> | undefined;
  try {
    installation = await installPrograms(
      runtime,
      [observe(fastRipgrep(workers)), observe(fastGrep(workers))],
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
      const result = await root.exec({
        executable: `/usr/bin/${vector.tool}`,
        argv: Array<string>(vector.tool).concat(vector.argv),
        env: vector.env,
        cwd: "/fixture",
      });
      const observed = observations.at(-1)!;
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
    return passed;
  } finally {
    admin.dispose();
    await root?.dispose();
    await installation?.dispose();
    await runtime.dispose();
    globalThis.Worker = NativeWorker;
    check(live.size === 0, `${live.size} program workers leaked`);
  }
}
