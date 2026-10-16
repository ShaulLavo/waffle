import { dirname, relative, join } from "node:path";

/** Shared page/worker build settings. The consuming app's main entry must be first. */
export function browserBuildConfig(entrypoints: string[], outdir: string, options: { splitting?: boolean } = {}): Parameters<typeof Bun.build>[0] {
  const main = entrypoints[0];
  if (!main) throw new Error("Browser build needs the consuming application's main entry");
  const consumer = dirname(main);
  return {
    entrypoints, outdir, target: "browser", format: "esm",
    splitting: options.splitting ?? true,
    minify: true, sourcemap: "linked", metafile: true,
    naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    plugins: [{
      name: "consumer-runtime-package",
      setup(build) {
        // Shared web sources belong to the app being built. A sandbox-only install
        // supplies this dependency; Bun's package resolver still enforces exports.
        build.onResolve({ filter: /^@bun-wasm\/runtime(?:\/|$)/ }, ({ path }) => ({
          path: Bun.resolveSync(path, consumer),
        }));
      },
    }],
  };
}

async function checked(config: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(config);
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return result;
}

export async function buildBrowserEntries(entrypoints: string[], outdir: string) {
  const result = await checked(browserBuildConfig(entrypoints, outdir));
  // Safari can fetch the bootstrap directly, before service-worker interception is ready.
  const worker = result.outputs.find((output) => relative(outdir, output.path) === "worker.js");
  if (!worker) throw new Error("Browser build is missing worker.js");
  // Relative imports resolve under __bunwasm/ for the scoped worker. Mirror every
  // chunk (including dynamic chunks and their maps), not just today's static closure.
  for (const output of result.outputs) {
    const path = relative(outdir, output.path);
    if (path === "worker.js" || path === "worker.js.map" || path.startsWith("chunks/")) {
      await Bun.write(join(outdir, "__bunwasm", path), output);
    }
  }
  return result;
}

/** Keep service workers standalone classic scripts for Safari. Never split this build. */
export function buildClassicWorker(entrypoint: string, outdir: string, define?: Record<string, string>) {
  return checked({ entrypoints: [entrypoint], outdir, define, target: "browser", format: "iife", minify: true, naming: "[name].[ext]" });
}
