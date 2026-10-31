import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

test("the documented browser build emits the requested measurement worker", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const docs = await Bun.file(join(root, "docs/getting-started.md")).text();
  const build = /bun build (.+) --outdir \.\/public --target browser --splitting/.exec(docs);
  if (!build?.[1]) throw new Error("missing documented build");
  const scratch = await mkdtemp("/work/tmp/waffle-probe-package-");
  const previousWorker = globalThis.Worker;
  let requested = "";
  try {
    await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    for (const match of docs.matchAll(/Create `([^`]+\.ts)`[^\n]*\n\n```ts\n([\s\S]*?)```/g))
      await writeFile(join(scratch, match[1]!), match[2]!);
    const built = await Bun.build({
      entrypoints: build[1].split(" ").map((path) => join(scratch, path)),
      outdir: join(scratch, "public"),
      target: "browser",
      splitting: true,
      format: "esm",
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    globalThis.Worker = class {
      constructor(url: string | URL) {
        requested = String(url);
        throw new Error("probe request captured");
      }
    } as unknown as typeof Worker;
    await expect(import(pathToFileURL(join(scratch, "public/app.js")).href)).rejects.toThrow(
      "probe request captured",
    );
    expect(requested).not.toBe("");
    expect(await Bun.file(fileURLToPath(requested)).exists()).toBe(true);
  } finally {
    globalThis.Worker = previousWorker;
    await rm(scratch, { recursive: true, force: true });
  }
});
