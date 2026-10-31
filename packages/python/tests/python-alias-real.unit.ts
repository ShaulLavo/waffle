import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { GuestLauncher } from "waffle";
import { PYTHON_ARGV0 } from "../src/python-payload.ts";
import { serveTestFiles } from "../test/assets-server.ts";
import { installNodeWorkers, liveNodeWorkers, stopNodeWorkers } from "../test/node-worker-host.ts";
import type { TestExecution } from "../../../tools/program-test-root.ts";

const artifact = process.env.PYTHON_ALIAS_ARTIFACT;
const paths = ["/usr/bin/python", "/usr/bin/python3", "/bin/python3"];
const cases = [
  {
    args: ["-I", "-c", "import os,sys; print(sys.flags.isolated); print(os.getcwd())"],
    expected: { status: 0, stdout: "1\n/home/guest\n", stderr: "" },
  },
  {
    args: [
      "-c",
      "import json,sys; print(json.dumps(sys.argv,ensure_ascii=False))",
      "",
      "two words",
      "β",
    ],
    expected: { status: 0, stdout: '["-c", "", "two words", "β"]\n', stderr: "" },
  },
  {
    args: ["-m", "json.tool", "--compact"],
    input: '{"b":2,"a":"é"}\n',
    expected: { status: 0, stdout: '{"b":2,"a":"\\u00e9"}\n', stderr: "" },
  },
  {
    args: ["-B", "-c", "import sys; print(sys.dont_write_bytecode)"],
    expected: { status: 0, stdout: "True\n", stderr: "" },
  },
  {
    args: ["-u", "-c", "import sys; print('out é'); print('err 終',file=sys.stderr); sys.exit(7)"],
    expected: { status: 7, stdout: "out é\n", stderr: "err 終\n" },
  },
];

async function cleanupActions(actions: readonly (() => unknown)[]) {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Alias qualification cleanup failed");
}

test(
  "real CPython aliases match canonical execution for the surveyed flags",
  {
    skip: artifact
      ? false
      : "Set PYTHON_ALIAS_ARTIFACT to an accepted full Python artifact directory",
    timeout: 120_000,
  },
  async (context) => {
    assert.ok(artifact);
    const { createRuntime } = await import("waffle");
    const { createPythonPackage } = await import("../src/index.ts");
    const { createProgramTestRoot } = await import("../../../tools/program-test-root.ts");
    const server = await serveTestFiles(resolve(artifact));
    const roots: Awaited<ReturnType<typeof createProgramTestRoot>>[] = [];
    const cleanup = [
      () => Promise.all(roots.map((root) => root.dispose())),
      stopNodeWorkers,
      () => server.close(),
    ];
    context.after(async () => {
      await cleanupActions(cleanup);
      assert.equal(liveNodeWorkers(), 0);
    });
    installNodeWorkers();
    const nodeRoot = new URL(".", import.meta.resolve("waffle"));
    const launches: Parameters<GuestLauncher>[0][] = [];
    const launcher: GuestLauncher = (guest, service) => {
      launches.push(guest);
      return service.launchWorker(guest, {
        workerUrl: import.meta.resolve("waffle/browser/preview1-worker"),
        request: {
          module: guest.module,
          args: guest.request.argv,
          env: guest.request.env,
          interruptible: guest.interruptible,
        },
      });
    };
    const owner = createRuntime({
      sharedMemory: testSharedMemory,
      filesystem: { mode: "memory", workerURL: new URL("browser/fs-worker.js", nodeRoot) },
      programs: { launcher },
    });
    cleanup.splice(1, 0, () => owner.dispose());
    const requests: string[] = [];
    const original = globalThis.fetch;
    context.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      return original(input, init);
    });
    await owner.programs.onDemand(
      createPythonPackage(owner, {
        wasmUrl: `${server.origin}/python.wasm`,
        payloadUrl: `${server.origin}/python-stdlib.json`,
      }),
    );
    assert.equal(owner.programs.status().length, 1);
    assert.deepEqual(requests, []);
    await owner.filesystem.mkdirp("/home/guest");
    for (let index = 0; index < paths.length; index++)
      roots.push(await createProgramTestRoot(owner));
    async function execute(args: string[], input?: string): Promise<TestExecution[]> {
      return Promise.all(
        roots.map((root, index) =>
          root.exec({
            executable: paths[index]!,
            argv: [paths[index]!].concat(args),
            cwd: "/home/guest",
            env: {
              PATH: "/usr/bin:/bin",
              PWD: "/stale",
              PYTHONDONTWRITEBYTECODE: "1",
              LC_ALL: "C.UTF-8",
              NO_COLOR: "1",
            },
            input,
          }),
        ),
      );
    }
    for (const result of await execute(["--version"]))
      assert.deepEqual(result, { status: 0, stdout: "Python 3.15.2\n", stderr: "" });
    const metadata: unknown = JSON.parse(
      await readFile(resolve(artifact, "python-stdlib.json"), "utf8"),
    );
    assert.ok(
      metadata &&
        typeof metadata === "object" &&
        "files" in metadata &&
        Array.isArray(metadata.files),
    );
    assert.equal(metadata.files.length, 2650);
    assert.equal(requests.length, metadata.files.length + 2);
    assert.equal(new Set(requests).size, requests.length);
    for (const example of cases) {
      const results = await execute(example.args, example.input);
      for (const result of results) assert.deepEqual(result, example.expected);
    }
    assert.equal(requests.length, metadata.files.length + 2);
    for (const launched of launches) {
      assert.equal(launched.module, launches[0]?.module);
      assert.equal(launched.request.argv[0], PYTHON_ARGV0);
    }
    context.diagnostic(
      JSON.stringify({
        paths,
        executions: launches.length,
        assetRequests: requests.length,
        duplicateRequests: 0,
      }),
    );
    for (const root of roots) await root.dispose();
    await owner.programs.get("/bin/python3")?.remove();
    for (const path of paths) assert.equal(await owner.filesystem.lookup(path), undefined);
    assert.equal(await owner.filesystem.lookup("/Lib/os.py"), undefined);
  },
);
