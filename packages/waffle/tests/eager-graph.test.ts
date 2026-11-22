import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// Modules that a split browser build loads before any dynamic import runs.
async function eagerInputs(entry: string): Promise<Set<string>> {
  const built = await Bun.build({
    entrypoints: [resolve(root, entry)],
    target: "browser",
    format: "esm",
    splitting: true,
    metafile: true,
  });
  expect(built.success).toBe(true);
  if (!built.metafile) throw new Error(`missing metadata for ${entry}`);
  const outputs = built.metafile.outputs;
  const start = Object.keys(outputs).find((key) => outputs[key]?.entryPoint !== undefined);
  if (start === undefined) throw new Error(`missing entry output for ${entry}`);
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of outputs[key]?.imports ?? [])
      if (next.kind === "import-statement" && outputs[next.path] !== undefined)
        queue.push(next.path);
  }
  const inputs = new Set<string>();
  for (const key of seen)
    for (const input of Object.keys(outputs[key]?.inputs ?? {}))
      inputs.add(relative(root, resolve(input)));
  return inputs;
}

// The filesystem service and its storage engines run only inside the filesystem worker, which
// loads them statically so worker disposal never waits on a module fetch.
const filesystemWorkerOnly = [
  "fs/service.ts",
  "fs/backend.ts",
  "fs/memory.ts",
  "fs/persistent.ts",
  "fs/indexeddb.ts",
  "fs/opfs.ts",
  "fs/safe-staging.ts",
  "fs/workspace-read.ts",
  "fs/watch-service.ts",
];

for (const entry of ["index.ts", "runtime.ts", "browser/worker.ts"]) {
  test(`${entry} loads no filesystem-worker module eagerly`, async () => {
    const inputs = await eagerInputs(entry);
    expect(inputs.has("fs/client.ts")).toBe(true);
    for (const path of filesystemWorkerOnly) expect(inputs.has(path), path).toBe(false);
  });
}

test("the filesystem worker itself still loads every filesystem-worker module", async () => {
  const inputs = await eagerInputs("browser/fs-worker.ts");
  for (const path of filesystemWorkerOnly) expect(inputs.has(path), path).toBe(true);
});
