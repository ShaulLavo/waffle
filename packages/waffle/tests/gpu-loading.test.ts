import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { posix } from "node:path";
import { checkGpuBudget, GPU_BUDGETS } from "../tooling/gpu-size.js";

for (const entry of [
  "runtime.ts",
  "core/index.ts",
  "fs/index.ts",
  "proc/index.ts",
  "browser/display/owner.ts",
]) {
  test(`${entry} has no eager GPU or process activation edge`, async () => {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
      splitting: true,
      metafile: true,
      target: "browser",
    });
    if (!build.success || !build.metafile) throw new Error(build.logs.join("\n"));
    const outputs = new Map(
      Object.entries(build.metafile.outputs).map(([path, value]) => [posix.normalize(path), value]),
    );
    const root = Array.from(outputs).find(([, value]) => value.entryPoint?.endsWith(entry));
    if (!root) throw new Error("Missing entry metadata");
    const visited = new Set<string>();
    function walk(path: string) {
      if (visited.has(path)) return;
      visited.add(path);
      for (const edge of outputs.get(path)?.imports ?? []) {
        if (edge.kind === "dynamic-import" || ("external" in edge && edge.external)) continue;
        walk(posix.normalize(posix.join(posix.dirname(path), edge.path)));
      }
    }
    walk(root[0]);
    const inputs = Array.from(visited).flatMap((path) => Object.keys(outputs.get(path)!.inputs));
    expect(inputs.filter((path) => /browser\/gpu\//.test(path))).toEqual([]);
    if (entry === "runtime.ts" || entry.startsWith("browser/display"))
      expect(
        inputs.filter((path) => /proc\/(?:supervisor|table|registry)\.ts$/.test(path)),
      ).toEqual([]);
  });
}
for (const entry of ["browser/worker.ts", "browser/gpu/guest.ts", "browser/display/guest.ts"]) {
  test(`${entry} never reaches the page display owner or GPU service, including dynamic imports`, async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
      metafile: true,
      target: "browser",
    });
    if (!result.success || !result.metafile) throw new Error(result.logs.join("\n"));
    expect(
      Object.keys(result.metafile.inputs).filter(
        (path) =>
          path.endsWith("memory/graphics-retention.ts") ||
          path.endsWith("browser/gpu/generated/tables.ts"),
      ),
    ).toEqual([]);
    expect(
      Object.keys(result.metafile.inputs).filter((path) =>
        /browser\/(?:display\/(?:owner|service-readers|launch-retention)|gpu\/(?:access|command-reader|service|service-worker|surfaces|replay|scheduler|completions))\.ts$/.test(
          path,
        ),
      ),
    ).toEqual([]);
  });
}
test("separate service entry reaches real WebGPU service without a process implementation", async () => {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../browser/gpu/service-worker.ts", import.meta.url))],
    metafile: true,
    target: "browser",
  });
  if (!result.success || !result.metafile) throw new Error(result.logs.join("\n"));
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.some((path) => path.endsWith("gpu/replay.ts"))).toBe(true);
  expect(inputs.some((path) => path.endsWith("gpu/surfaces.ts"))).toBe(true);
  expect(inputs.filter((path) => /proc\/(?:supervisor|table|registry)\.ts$/.test(path))).toEqual(
    [],
  );
});
test("all GPU budgets reject a byte beyond the limit", () => {
  for (const name of Object.keys(GPU_BUDGETS) as (keyof typeof GPU_BUDGETS)[]) {
    expect(() => checkGpuBudget(name, GPU_BUDGETS[name])).not.toThrow();
    expect(() => checkGpuBudget(name, GPU_BUDGETS[name] + 1)).toThrow();
  }
});

test("display open boundary imports and rejects opens when SharedArrayBuffer is absent", () => {
  const url = new URL("../browser/display/open.ts", import.meta.url).href;
  const script = `Reflect.deleteProperty(globalThis, "SharedArrayBuffer");
    const { validGraphicsOpen } = await import(${JSON.stringify(url)});
    if (validGraphicsOpen({type:"open",id:1,control:0},64,64)) throw Error("accepted open without SAB");`;
  const result = Bun.spawnSync([process.execPath, "-e", script]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
