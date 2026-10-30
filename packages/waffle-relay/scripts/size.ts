import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dir, "../../..");
const base = process.argv[2] ?? "e956c496c16a0e84b0ed3ab667ae9fa269f5f725";
const helper = "packages/waffle/browser/net/helper.ts";
const baseline = execFileSync("git", ["show", `${base}:${helper}`], {
  cwd: root,
  encoding: "utf8",
});
const temporary =
  process.env.WAFFLE_RELAY_TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
const scratch = mkdtempSync(join(temporary, "waffle-relay-size-"));

async function bundle(entry: string, before = false) {
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    target: "browser",
    format: "esm",
    minify: true,
    splitting: true,
    outdir: scratch,
    metafile: true,
    plugins: before
      ? [
          {
            name: "relay-baseline",
            setup(build) {
              build.onLoad({ filter: /\/browser\/net\/helper\.ts$/ }, () => ({
                contents: baseline,
                loader: "ts",
              }));
            },
          },
        ]
      : [],
  });
  assert.ok(result.success, result.logs.map(String).join("\n"));
  assert.ok(result.metafile);
  const outputs = result.metafile.outputs;
  const entryKey = Object.keys(outputs).find((key) => outputs[key]?.entryPoint?.endsWith(entry));
  assert.ok(entryKey, "Missing bundle entry");
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    for (const dependency of outputs[key]?.imports ?? []) {
      if (dependency.kind === "import-statement" && dependency.path in outputs)
        visit(dependency.path);
    }
  };
  visit(entryKey);
  const initialInputs = Array.from(visited).flatMap((key) =>
    Object.keys(outputs[key]?.inputs ?? {}),
  );
  const initial = result.outputs.filter((output) => visited.has(`./${basename(output.path)}`));
  let raw = 0,
    gzip = 0;
  for (const output of initial) {
    const bytes = Buffer.from(await output.arrayBuffer());
    raw += bytes.byteLength;
    gzip += gzipSync(bytes, { level: 9 }).byteLength;
  }
  return { raw, gzip, initialInputs, allInputs: Object.keys(result.metafile.inputs) };
}

try {
  const before = await bundle("packages/waffle/index.ts", true);
  const after = await bundle("packages/waffle/index.ts");
  assert.ok(
    !after.allInputs.some((input) => input.includes("waffle-relay")),
    "Relay entered the runtime dependency graph",
  );
  assert.ok(
    !after.initialInputs.some((input) => /net\/(helper|transport)\.ts$/.test(input)),
    "Fetch metadata entered the eager runtime graph",
  );
  const client = await bundle("packages/waffle-relay/src/index.ts");
  const worker = await bundle("packages/waffle-relay/src/worker.ts");
  console.log(
    JSON.stringify(
      {
        base,
        runtimeInitial: {
          before: { raw: before.raw, gzip: before.gzip },
          after: { raw: after.raw, gzip: after.gzip },
          rawDelta: after.raw - before.raw,
          gzipDelta: after.gzip - before.gzip,
        },
        client: { raw: client.raw, gzip: client.gzip },
        worker: { raw: worker.raw, gzip: worker.gzip },
        relayInRuntimeGraph: false,
        transportInInitialGraph: false,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
