import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

test("P5 documented two-entry browser build starts the default runtime with its real filesystem Worker", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const docs = await Bun.file(join(root, "docs/getting-started.md")).text();
  const build = /bun build (.+) --outdir \.\/public --target browser --splitting/.exec(docs);
  if (!build?.[1]) throw new Error("missing documented build");
  expect(build[1].split(" ")).toEqual(["./app.ts", "./fs-worker.ts"]);
  expect(docs).not.toMatch(/measureSharedMemory|probe-worker/);
  const scratch = await mkdtemp(join(tmpdir(), "waffle-default-package-"));
  try {
    await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    for (const match of docs.matchAll(/Create `([^`]+\.ts)`[^\n]*\n\n```ts\n([\s\S]*?)```/g)) {
      const content =
        match[1] === "app.ts"
          ? `globalThis.documentedStartup=(async()=>{${match[2]!.replace(/^import .*?;\n/m, "")} })();`
          : match[2]!;
      const text =
        match[1] === "app.ts" ? `import {createRuntime} from "waffle";\n${content}` : content;
      await writeFile(
        join(scratch, match[1]!),
        text
          .replace(
            'workerURL: "/fs-worker.js"',
            'workerURL: new URL("./fs-worker.js", import.meta.url)',
          )
          .replace(
            "try {",
            "globalThis.documentedPlatform=runtime.sharedMemory.snapshot().platform;\ntry {",
          ),
      );
    }
    const built = await Bun.build({
      entrypoints: build[1].split(" ").map((path) => join(scratch, path)),
      outdir: join(scratch, "public"),
      target: "browser",
      splitting: true,
      format: "esm",
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    expect(built.outputs.some((output) => output.path.includes("probe"))).toBe(false);
    const result = spawnSync(
      process.execPath,
      [
        new URL("./fixtures/documented-startup-control.ts", import.meta.url).pathname,
        pathToFileURL(join(scratch, "public/app.js")).href,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
