import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { readdirSync } from "node:fs";
import * as native from "../../proc/intrinsics.ts";

const processRoot = new URL("../../proc/", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const modules = readdirSync(processRoot).filter(
  (name) => name.endsWith(".ts") && name !== "intrinsics.ts",
);

/**
 * Bundle a fresh process graph with test-owned intrinsic forwarding seams.
 * Native core/filesystem modules are borrowed so descriptor/error identities stay
 * intact. Nothing replaces production globals or entries in Bun's module cache.
 */
export async function isolatedProcess() {
  const atomics = Object.create(Atomics) as typeof Atomics;
  const hooks = { typedArraySubarray: native.typedArraySubarray };
  const intrinsics: Record<string, unknown> = { ...native };
  for (const key of Object.keys(native)) {
    if (!key.startsWith("atomics")) continue;
    const suffix = key.slice("atomics".length);
    const name = suffix[0]!.toLowerCase() + suffix.slice(1);
    intrinsics[key] = (...args: unknown[]) =>
      Reflect.apply(Reflect.get(atomics, name), atomics, args);
  }
  intrinsics.typedArraySubarray = (view: Uint8Array, begin?: number, end?: number) =>
    hooks.typedArraySubarray(view, begin, end);
  const result = await Bun.build({
    entrypoints: ["isolated-process-entry"],
    target: "node",
    format: "cjs",
    plugins: [
      {
        name: "test-owned-process-intrinsics",
        setup(build) {
          build.onResolve({ filter: /^isolated-process-entry$/ }, () => ({
            path: "entry",
            namespace: "isolated-process",
          }));
          build.onLoad({ filter: /.*/, namespace: "isolated-process" }, () => ({
            loader: "ts",
            contents: modules
              .map(
                (name, index) =>
                  `export * as module${index} from ${JSON.stringify(resolve(processRoot, name))};`,
              )
              .concat([
                `export * as wasi from ${JSON.stringify(resolve(processRoot, "../core/wasi.ts"))};`,
              ])
              .join("\n"),
          }));
          build.onResolve({ filter: /^(?:\.\.?\/|\/)/ }, (args) => {
            const path = resolve(args.resolveDir || dirname(args.importer), args.path);
            if (!path.startsWith(processRoot.endsWith(sep) ? processRoot : processRoot + sep))
              return { path, external: true };
          });
          build.onLoad({ filter: /\/proc\/intrinsics\.ts$/ }, () => ({
            loader: "ts",
            contents: Object.keys(native)
              .map((key) => `export const ${key} = __processIntrinsics.${key};`)
              .join("\n"),
          }));
        },
      },
    ],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Isolated process fixture bundle failed");
  const output = { exports: {} as Record<string, unknown> };
  const evaluated = new Function(
    "require",
    "module",
    "exports",
    "__processIntrinsics",
    await result.outputs[0]!.text(),
  )(require, output, output.exports, intrinsics) as Record<string, unknown> | undefined;
  const exports = evaluated ?? output.exports;
  return {
    atomics,
    hooks,
    load<T>(name: string): T {
      if (name === "wasi") return exports.wasi as T;
      const index = modules.indexOf(name.replace(/\.(?:js|ts)$/, "") + ".ts");
      if (index < 0) throw new Error(`Unknown isolated process module: ${name}`);
      return exports[`module${index}`] as T;
    },
  };
}
