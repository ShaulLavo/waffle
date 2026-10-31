import { createRuntime } from "waffle";
import { createShell } from "../../src/shell.ts";
import { installFind } from "../../src/utilities/find.ts";
import { seedFindTree } from "./find-cases.ts";

async function source() {
  const response = await fetch("/find.wasm");
  if (!response.ok) throw new Error("find guest fetch failed");
  return new Uint8Array(await response.arrayBuffer());
}

async function run(runtime: ReturnType<typeof createRuntime>, script: string) {
  const shell = await createShell({
    runtime,
    workerUrl: "/shell-worker.js",
    wasmUrl: "/shell-runtime.wasm",
    cwd: "/tree",
    env: { PATH: "/bin", LC_ALL: "C", TZ: "UTC" },
    script: `{ ${script}; } > /result 2>/diagnostic`,
  });
  try {
    const result = await shell.done;
    const stdout = Array.from((await runtime.filesystem.readFile("/result")) ?? []);
    const stderr = (await runtime.filesystem.readFile("/diagnostic")) ?? new Uint8Array();
    return { status: result.code, stdout, diagnostic: new TextDecoder().decode(stderr) };
  } finally {
    await shell.dispose();
  }
}

export async function checkFind(script: string) {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "/fs-worker.js" } });
  let loads = 0;
  const load = () => {
    loads++;
    return source();
  };
  try {
    await seedFindTree(runtime);
    const installation = await installFind(runtime, {
      workerUrl: "/shell-worker.js",
      source: load,
    });
    if (loads !== 0) throw new Error("find loaded before first use");
    const result = await run(runtime, script);
    await installation.dispose();
    return {
      ...result,
      loads,
      removed: !(await runtime.filesystem.lookup("/bin/find")),
      ownerAlive: !runtime.disposed,
    };
  } finally {
    await runtime.dispose();
  }
}
