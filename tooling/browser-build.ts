import { relative, join, resolve, isAbsolute, dirname } from "node:path";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const runtimeName = "@bun-wasm/runtime";

/** Resolve only the consuming installation, without assuming checkout/cache directory names. */
export function resolveRuntimePackage(consumerEntry: string) {
  const path = (createRequire(resolve(consumerEntry)).resolve.paths(runtimeName) ?? [])
    .map(directory => join(directory, runtimeName)).find(directory => existsSync(join(directory, "package.json")));
  if (!path) throw new Error(`The consuming app must install ${runtimeName}`);
  // Bun file: installs can symlink each file rather than the package directory.
  const physical = dirname(realpathSync(join(path, "package.json")));
  const metadata = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  function inside(root: string, candidate: string): string | undefined {
    const rel = relative(root, candidate);
    return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel.replaceAll("\\", "/");
  }
  function select(value: unknown): string | null | undefined {
    if (typeof value === "string" || value === null) return value;
    if (typeof value !== "object") return undefined;
    for (const [condition, target] of Object.entries(value)) {
      if (["browser", "bun", "import", "default"].includes(condition)) {
        const selected = select(target);
        if (selected !== undefined) return selected;
      }
    }
  }
  return {
    path, physical, metadata,
    source(specifier: string): string {
      if (specifier !== runtimeName && !specifier.startsWith(runtimeName + "/")) throw new Error(`Not a runtime import: ${specifier}`);
      const key = specifier === runtimeName ? "." : "." + specifier.slice(runtimeName.length);
      const target = select(metadata.exports?.[key]);
      if (!target) throw new Error(`${specifier} is not exported for the browser`);
      const output = resolve(path, target);
      if (!target.startsWith("./") || inside(path, output) === undefined) throw new Error(`Invalid runtime export: ${target}`);
      if (!existsSync(output)) throw new Error(`Missing runtime export: ${output}`);
      if (inside(physical, realpathSync(output)) === undefined) throw new Error(`Runtime export escapes installed package: ${target}`);
      return output;
    },
    relativeInput(input: string, base = process.cwd()): string | undefined {
      const absolute = resolve(base, input);
      return inside(path, absolute) ?? inside(physical, absolute);
    },
  };
}

export type RuntimePackage = ReturnType<typeof resolveRuntimePackage>;

/** Shared page/worker build settings. The consuming app's main entry must be first. */
export function browserBuildConfig(entrypoints: string[], outdir: string, options: { splitting?: boolean; runtimeWorker?: boolean } = {}): Parameters<typeof Bun.build>[0] {
  const main = entrypoints[0];
  if (!main) throw new Error("Browser build needs the consuming application's main entry");
  let runtimePackage: RuntimePackage | undefined;
  if (options.runtimeWorker) {
    runtimePackage = resolveRuntimePackage(main);
    entrypoints = entrypoints.concat([runtimePackage.source("@bun-wasm/runtime/browser/preview1-worker")]);
  }
  return {
    entrypoints, outdir, target: "browser", format: "esm",
    splitting: options.splitting ?? true,
    minify: true, sourcemap: "linked", metafile: true,
    naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    plugins: [{
      name: "consumer-runtime-package",
      setup(build) {
        // Shared web sources still use the app's installation. Explicit package
        // exports enforce the boundary; dotted Git-cache names are opaque paths.
        build.onResolve({ filter: /^@bun-wasm\/runtime(?:\/|$)/ }, ({ path }) => {
          runtimePackage ??= resolveRuntimePackage(main);
          return { path: runtimePackage.source(path) };
        });
      },
    }],
  };
}

async function checked(config: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(config);
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return result;
}

export async function buildBrowserEntries(entrypoints: string[], outdir: string, options: { runtimeWorker?: boolean } = {}) {
  const result = await checked(browserBuildConfig(entrypoints, outdir, options));
  // Safari can fetch the bootstrap directly, before service-worker interception is ready.
  const worker = result.outputs.find((output) => relative(outdir, output.path) === "worker.js");
  if (!worker) throw new Error("Browser build is missing worker.js");
  // Relative imports resolve under __bunwasm/ for the scoped worker. Mirror every
  // chunk (including dynamic chunks and their maps), not just today's static closure.
  for (const output of result.outputs) {
    const path = relative(outdir, output.path);
    if (path === "worker.js" || path === "worker.js.map" || path === "fs-worker.js" || path === "fs-worker.js.map" || path === "preview1-worker.js" || path === "preview1-worker.js.map" || path.startsWith("chunks/")) {
      await Bun.write(join(outdir, "__bunwasm", path), output);
    }
  }
  return result;
}

/** Keep service workers standalone classic scripts for Safari. Never split this build. */
export function buildClassicWorker(entrypoint: string, outdir: string, define?: Record<string, string>) {
  return checked({ entrypoints: [entrypoint], outdir, define, target: "browser", format: "iife", minify: true, naming: "[name].[ext]" });
}
