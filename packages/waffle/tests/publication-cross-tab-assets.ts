import { resolve } from "node:path";
import { browserBundle } from "./browser-runner-lifecycle.js";

async function crossTabGuestBundle(): Promise<Blob> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/publication-resident-guest.ts")],
    target: "browser",
    plugins: [
      {
        name: "private-claim-test-observer",
        setup(build) {
          build.onLoad({ filter: /fs\/publication-grant\.ts$/ }, async ({ path }) => {
            const source = await Bun.file(path).text();
            const marker = '    try {\n      if (grant.kind === "read") return this.readClaimed';
            if (source.split(marker).length !== 2) throw new Error("claim test marker changed");
            const observation =
              '    const observe = Reflect.get(globalThis, "__publicationClaimed");\n    if (typeof observe === "function") observe();\n';
            return { contents: source.replace(marker, observation + marker), loader: "ts" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "test-only guest bundle failed");
  return build.outputs[0]!;
}
export async function crossTabAssets(): Promise<Record<string, Blob | string>> {
  return {
    "/cross-tab.js": await browserBundle(
      resolve(import.meta.dir, "publication-cross-tab-browser.ts"),
    ),
    "/resident-authority.js": await browserBundle(
      resolve(import.meta.dir, "fixtures/publication-resident-authority.ts"),
    ),
    "/resident-guest.js": await crossTabGuestBundle(),
    "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
  };
}
