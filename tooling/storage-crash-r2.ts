import { existsSync } from "node:fs";
import { BrowserRunnerLifecycle } from "../tests/browser-runner-lifecycle.js";
import { mutants, verifyMatrix, type Mutation } from "./storage-crash-r2-mutations.js";

export async function crashMatrixBundle(mutant?: Mutation): Promise<Blob> {
  let transformed = 0;
  const load = async ({ path }: { path: string }) => {
    if (!mutant || !path.endsWith(`/fs/${mutant.file}`)) return;
    const source = await Bun.file(path).text();
    if (source.split(mutant.old).length !== 2)
      throw new Error(`Mutation must match exactly once: ${mutant.id}`);
    transformed++;
    return { contents: source.replace(mutant.old, mutant.replacement), loader: "ts" as const };
  };
  const plugins: Bun.BunPlugin[] = mutant
    ? [
        {
          name: mutant.id,
          setup(build) {
            build.onLoad({ filter: /\/fs\/(persistent|opfs)\.ts$/ }, load);
          },
        },
      ]
    : [];
  const build = await Bun.build({
    entrypoints: [new URL("../tests/storage-crash-r2-browser.ts", import.meta.url).pathname],
    target: "browser",
    plugins,
  });
  if (!build.success) throw new AggregateError(build.logs, "Crash matrix browser build failed");
  if (transformed !== (mutant ? 1 : 0))
    throw new Error("In-memory mutation was not applied exactly once");
  const output = build.outputs[0];
  if (!output) throw new Error("Crash matrix browser build produced no output");
  return output;
}
async function runBrowserMatrix(id: string) {
  const suite: typeof import("../tests/storage-crash-r2-browser.js") = await import(`/${id}.js`);
  return suite.crashMatrix();
}
async function main() {
  const lifecycle = new BrowserRunnerLifecycle(180_000);
  let removed = false;
  try {
    await lifecycle.init();
    const variants: (Mutation | undefined)[] = Array<Mutation | undefined>(undefined).concat(
      process.argv.includes("--mutants") ? mutants : [],
    );
    const routes: Record<string, Blob | string> = {
      "/": "<!doctype html><title>Bounded storage crash schedules</title>",
    };
    for (const variant of variants)
      routes[`/${variant?.id ?? "baseline"}.js`] = await crashMatrixBundle(variant);
    const origin = lifecycle.serve(routes, 46437);
    const browser = await lifecycle.launch("chromium");
    for (const variant of variants) {
      const page = await browser.newPage();
      await page.goto(origin);
      const result = await page.evaluate(runBrowserMatrix, variant?.id ?? "baseline");
      console.log(
        JSON.stringify(
          {
            variant: variant?.id ?? "baseline",
            browser: browser.version(),
            ...result,
            limits: [
              "manual runner, not browser CI",
              "FAST memory ACK is not durable flush; intervalMs=0 does not test timer checkpoints",
              "SAFE unsupported and untested",
              "no browser-kill or physical power-loss claim",
              "OPFS uses the existing byte-store fixture, not native OPFS",
              "bounded next E6/W8 proof, not full certification",
            ],
          },
          null,
          2,
        ),
      );
      verifyMatrix(result, variant);
      await page.close();
    }
  } finally {
    await lifecycle.close();
    removed = !existsSync(lifecycle.scratch);
    console.log(JSON.stringify({ phase: "cleanup", ownedScratch: lifecycle.scratch, removed }));
  }
  if (!removed) throw new Error("Owned browser scratch remains");
}
if (import.meta.main) await main();
