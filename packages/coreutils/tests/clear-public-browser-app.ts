import { testSharedMemory } from "../../waffle/tests/fixtures/shared-memory-platform.js";
import { createRuntime } from "waffle";
import { installPrograms } from "waffle/programs";
import { coreutils } from "waffle-coreutils";
import { createProgramTestRoot } from "../../../tools/program-test-root.ts";
import assert from "../../../tools/test-assert.ts";

const runtime = createRuntime({
  sharedMemory: testSharedMemory,
  filesystem: { mode: "memory", workerURL: new URL("/fs-worker.js", location.href) },
});
const full = "\x1b[H\x1b[2J\x1b[3J";
const cases: Array<{
  name: string;
  args: string[];
  env: Record<string, string>;
  stdout: string;
  status: number;
}> = [
  {
    name: "default xterm-256color",
    args: [],
    env: { TERM: "xterm-256color" },
    stdout: full,
    status: 0,
  },
  { name: "default xterm", args: [], env: { TERM: "xterm" }, stdout: full, status: 0 },
  {
    name: "default xterm-ghostty",
    args: [],
    env: { TERM: "xterm-ghostty" },
    stdout: full,
    status: 0,
  },
  { name: "-x", args: ["-x"], env: { TERM: "xterm" }, stdout: "\x1b[H\x1b[2J", status: 0 },
  { name: "explicit -T without TERM", args: ["-T", "xterm"], env: {}, stdout: full, status: 0 },
  { name: "missing TERM", args: [], env: {}, stdout: "", status: 1 },
  { name: "unknown TERM", args: [], env: { TERM: "dumb" }, stdout: "", status: 1 },
  { name: "invalid option", args: ["--bad"], env: { TERM: "xterm" }, stdout: "", status: 1 },
];

async function campaign() {
  const fetches: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = new Proxy(original, {
    apply(target, receiver, args) {
      fetches.push(String(args[0]));
      return Reflect.apply(target, receiver, args);
    },
  });
  let installation: Awaited<ReturnType<typeof installPrograms>> | undefined;
  let root: Awaited<ReturnType<typeof createProgramTestRoot>> | undefined;
  try {
    await runtime.filesystem.writeFile("/caller-data", "preserve me");
    installation = await installPrograms(runtime, [coreutils], {
      launcher: (context, service) =>
        service.launchWorker(context, {
          workerUrl: new URL("/preview1-worker.js", location.href).href,
          request: {
            module: context.module,
            args: context.request.argv,
            env: context.request.env,
            interruptible: context.interruptible,
          },
        }),
    });
    assert.equal(fetches.length, 0, "install eagerly fetched a guest");
    root = await createProgramTestRoot(runtime);
    const observations = [];
    for (const item of cases) {
      const result = await root.exec({
        executable: "/bin/clear",
        argv: ["clear"].concat(item.args),
        env: item.env,
        cwd: "/",
      });
      observations.push({ name: item.name, ...result });
      console.log(JSON.stringify({ case: item.name, ...result }));
      assert.equal(result.status, item.status, item.name);
      assert.equal(result.stdout, item.stdout, item.name);
      assert.equal(result.status === 0 ? result.stderr : "", "", item.name);
      assert.ok(result.status === 0 || result.stderr.length > 0, "missing diagnostic");
    }
    assert.equal(fetches.length, 1, "guest was not loaded lazily once");
    assert.ok(fetches[0]?.endsWith("/dist/clear.wasm"), "unexpected guest source");
    await runtime.filesystem.writeFile("/bin/clear", "caller replacement");
    await installation.dispose();
    await installation.dispose();
    assert.equal(runtime.disposed, false, "installer disposed caller runtime");
    for (const path of installation.executables.filter((path) => path !== "/bin/clear"))
      assert.equal(await runtime.filesystem.lookup(path), undefined, `retained marker ${path}`);
    const decoder = new TextDecoder();
    assert.equal(
      decoder.decode(await runtime.filesystem.readFile("/bin/clear")),
      "caller replacement",
    );
    assert.equal(decoder.decode(await runtime.filesystem.readFile("/caller-data")), "preserve me");
    await runtime.filesystem.writeFile("/owner-alive", "alive");
    assert.equal(decoder.decode(await runtime.filesystem.readFile("/owner-alive")), "alive");
    return { ok: true, observations, fetches, runtimeBorrowed: true, callerDataPreserved: true };
  } finally {
    globalThis.fetch = original;
    await root?.dispose();
    await installation?.dispose();
  }
}

try {
  document.body.textContent = JSON.stringify(await campaign());
} catch (error) {
  document.body.textContent = JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
  });
} finally {
  await runtime.dispose();
  document.body.dataset.disposed = String(runtime.disposed);
  document.body.dataset.done = "true";
}
