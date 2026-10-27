import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import { basePackages, basePrograms, installBase } from "waffle-base";
import { runFamilyAcceptance } from "./family-acceptance.ts";
import { admitProgramPackage, packProgramPackage } from "./program-package.ts";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workerUrl = new URL("../packages/waffle/browser/preview1-worker.ts", import.meta.url);

test("23 real programs install lazily, run on one generic runtime, and release their paths", async () => {
  assert.equal(basePrograms.length, 23);
  const fetches: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    fetches.push(String(input));
    return original(input, init);
  };
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../packages/waffle/browser/fs-worker.ts", import.meta.url),
    },
  });
  try {
    const installed = await installBase(runtime, {
      launcher: (context, service) =>
        service.launchWorker(context, {
          workerUrl: workerUrl.href,
          request: {
            module: context.module,
            args: context.request.argv,
            env: context.request.env,
            interruptible: context.interruptible,
          },
        }),
    });
    assert.deepEqual(installed.path, ["/usr/bin", "/bin"]);
    assert.equal(installed.executables.length, 46);
    for (const path of installed.executables)
      assert.equal((await runtime.filesystem.lookup(path))?.kind, "file", path);
    assert.equal(fetches.length, 0, "installation eagerly fetched a guest");
    await installed.dispose();
    for (const path of installed.executables)
      assert.equal(await runtime.filesystem.lookup(path), undefined, path);
    const [coreutils, findutils, grep, ripgrep, sed] = basePackages;
    const completed = await runFamilyAcceptance({
      runtime,
      workerUrl,
      assets: { coreutils, findutils, grep, ripgrep, sed },
    });
    assert.equal(completed.length, 11);
    console.log(JSON.stringify({ runtime: "one borrowed Waffle Runtime", completed }));
    assert.equal(
      fetches.filter((url) => url.endsWith("/cat.wasm")).length,
      1,
      "cat aliases loaded twice",
    );
    for (const path of installed.executables)
      assert.equal(
        await runtime.filesystem.lookup(path),
        undefined,
        `retained after acceptance: ${path}`,
      );
  } finally {
    globalThis.fetch = original;
    await runtime.dispose();
  }
  assert.equal(runtime.disposed, true);
}, 90_000);

test("every shipped guest has only public imports and complete packed license/assets", () => {
  for (const family of basePackages) {
    const directory = resolve(root, "packages", family.name);
    const required = admitProgramPackage(directory);
    assert.ok(required.some((file) => file.endsWith("NOTICES.txt")));
    for (const program of family.programs) {
      assert.ok(program.wasm);
      const module = new WebAssembly.Module(readFileSync(program.wasm));
      for (const imported of WebAssembly.Module.imports(module))
        assert.ok(
          !["shell_terminal", "waffle_program", "waffle_executable"].includes(imported.module),
          `${program.path}: private import ${imported.module}`,
        );
    }
    console.log(JSON.stringify({ family: family.name, archive: packProgramPackage(directory) }));
  }
  console.log(
    JSON.stringify({ family: "base", archive: packProgramPackage(resolve(root, "packages/base")) }),
  );
}, 90_000);
