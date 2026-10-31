import type { Runtime, GuestLauncher } from "waffle";
import assert from "../../../tools/test-assert.ts";
import { createProgramTestRoot } from "../../../tools/program-test-root.ts";
import { installPython } from "@waffle/python/install";
import { PYTHON_ARGV0 } from "@waffle/python";
import { cases, sources } from "./cases.ts";
import type { PublicUsageCase } from "./cases.ts";
import { qualifyPublicUsage } from "./public-usage.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function qualifyPython(
  runtime: Runtime,
  options: {
    workerUrl: URL;
    wasmUrl: URL;
    payloadUrl: URL;
    publicUsageCases?: readonly PublicUsageCase[];
  },
) {
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = new Proxy(original, {
    apply(target, receiver, args) {
      const url = String(args[0]);
      if (url.includes("/assets/")) requests.push(url);
      return Reflect.apply(target, receiver, args);
    },
  });
  const launches: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  const launcher: GuestLauncher = (context, service) => {
    launches.push({
      argv: context.request.argv.slice(),
      cwd: context.request.cwd,
      env: { ...context.request.env },
    });
    return service.launchWorker(context, {
      workerUrl: options.workerUrl.href,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    });
  };
  let installation: Awaited<ReturnType<typeof installPython>> | undefined;
  let root: Awaited<ReturnType<typeof createProgramTestRoot>> | undefined;
  try {
    installation = await installPython(runtime, { ...options, launcher });
    assert.equal(requests.length, 0, "Python installation eagerly fetched assets");
    assert.equal(launches.length, 0, "Python installation launched a process");
    await runtime.filesystem.writeFile("/caller-data", "preserve me");
    await runtime.filesystem.mkdirp("/home/guest");
    for (const [name, text] of Object.entries(sources))
      await runtime.filesystem.writeFile(`/home/guest/${name}`, text);
    // Borrow one identical stdlib file and verify it survives this installation's disposal.
    const osUrl = new URL("python-files/Lib/os.py", options.payloadUrl);
    const borrowedResponse = await original(osUrl);
    check(borrowedResponse.ok, "Borrowed stdlib fixture fetch failed");
    const borrowed = new Uint8Array(await borrowedResponse.arrayBuffer());
    await runtime.filesystem.writeFile("/Lib/os.py", borrowed);
    root = await createProgramTestRoot(runtime);
    const results: unknown[] = [];
    let cold = 0;
    for (const example of cases) {
      const env = caseEnvironment(example.pwd);
      const expectedEnv = JSON.stringify(env);
      const argv = ["python", `/home/guest/${example.script}`].concat(example.args);
      const actual = await root.exec({
        executable: "/usr/bin/python",
        argv,
        cwd: "/home/guest",
        env,
      });
      assert.deepEqual(
        actual,
        { status: example.status, stdout: example.stdout, stderr: example.stderr },
        example.script,
      );
      assert.equal(JSON.stringify(env), expectedEnv, "Launcher mutated caller environment");
      const launched = launches.at(-1);
      check(launched, "Missing actual Python launch record");
      assert.equal(launched.env.PWD, "/home/guest");
      assert.equal(launched.env.TOKEN, "preserved");
      assert.deepEqual(launched.argv, [PYTHON_ARGV0].concat(argv.slice(1)));
      cold ||= requests.length;
      check(cold > 2650, "Full payload was not loaded");
      assert.equal(requests.length, cold, "Warm Python fetched its assets again");
      results.push({ script: example.script, pwd: example.pwd, ...actual });
    }
    assert.equal(
      new TextDecoder().decode(await runtime.filesystem.readFile("/home/guest/created.json")),
      '{"answer": 42, "square": 49}',
    );
    const publicUsage = await qualifyPublicUsage(runtime, root, launches, options.publicUsageCases);
    assert.equal(requests.length, cold, "Python usage cases fetched warm assets again");
    await root.dispose();
    root = undefined;
    await installation.dispose();
    installation = undefined;
    assert.equal(await runtime.filesystem.lookup("/usr/bin/python"), undefined);
    assert.equal(
      await runtime.filesystem.lookup("/cross-build/wasm32-wasip1/pybuilddir.txt"),
      undefined,
    );
    assert.equal(
      new TextDecoder().decode(await runtime.filesystem.readFile("/caller-data")),
      "preserve me",
    );
    assert.deepEqual(
      Array.from((await runtime.filesystem.readFile("/Lib/os.py")) ?? []),
      Array.from(borrowed),
    );
    return {
      results,
      publicUsage,
      coldRequests: cold,
      warmRequests: 0,
      launches: launches.length,
      callerDataPreserved: true,
      borrowedStdlibPreserved: true,
      runtimeBorrowed: !runtime.disposed,
    };
  } finally {
    globalThis.fetch = original;
    await root?.dispose();
    await installation?.dispose();
  }
}

function caseEnvironment(pwd: "absent" | "stale"): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    PYTHONDONTWRITEBYTECODE: "1",
    LC_ALL: "C.UTF-8",
    TOKEN: "preserved",
  };
  if (pwd === "stale") env.PWD = "/stale-directory";
  return env;
}
