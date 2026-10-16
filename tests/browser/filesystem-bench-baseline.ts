import { resolve, sep } from "node:path";

/** Keep imports made by the named baseline inside that archive. In particular, main's
 * web/src/fs.ts reexports its own runtime package; resolving that through the head
 * consumer would silently benchmark the changed MemoryBackend in both direct arms. */
export function filesystemBaselinePlugin(root: string): Bun.BunPlugin {
  const baseline = resolve(root);
  return { name: "named-baseline", setup(build) {
    build.onResolve({ filter: /^benchmark:baseline-/ }, ({ path }) => ({ path: resolve(baseline, path.endsWith("core") ? "runtime/core/index.ts" : "web/src/fs.ts") }));
    build.onResolve({ filter: /^@bun-wasm\/runtime(?:\/|$)/ }, ({ path, importer }) => {
      if (importer.startsWith(baseline + sep)) return { path: Bun.resolveSync(path, resolve(baseline, "runtime")) };
    });
  } };
}
