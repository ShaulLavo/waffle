import assert from "./test-assert.ts";
import type { Runtime } from "waffle";
import { basePackages, basePrograms, installBase } from "waffle-base";
import { runFamilyAcceptance } from "./family-acceptance.ts";

export async function runLazyBaseAcceptance(runtime: Runtime, workerUrl: URL) {
  const paths = new Set(basePrograms.map((program) => program.path));
  assert.equal(paths.size, basePrograms.length, "base families repeat a canonical path");
  const fetches: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = new Proxy(original, {
    apply(target, receiver, args) {
      fetches.push(String(args[0]));
      return Reflect.apply(target, receiver, args);
    },
  });
  let installed: Awaited<ReturnType<typeof installBase>> | undefined;
  try {
    installed = await installBase(runtime, {
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
    const aliases = basePrograms.flatMap((program) => program.aliases ?? []);
    assert.equal(installed.executables.length, basePrograms.length + aliases.length);
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
    return {
      completed,
      fetches: fetches.length,
      canonicalPrograms: basePrograms.length,
      executablePaths: installed.executables.length,
    };
  } finally {
    globalThis.fetch = original;
    await installed?.dispose();
  }
}
