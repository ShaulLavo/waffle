import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser } from "@playwright/test";

/** Chromium proofs on real Bun. `six` (default): the six local commands through the API and
 * `/usr/bin/git`. `lookup`: Bash PATH and Bun.spawn find `git` by name; it also needs the staged
 * bash-web source (GIT_BASH_SOURCE) and its CI shell guest (GIT_SHELL_GUEST), both read-only.
 * `dispose`: filesystem only, no Bun; program dispose preserves caller replacements.
 * Owns its scratch build, loopback listener and browser; all three are removed on every exit path.
 */
const page = process.argv[2] ?? "six";
const entryNames: Record<string, string> = { six: "main", lookup: "lookup", dispose: "dispose" };
const globals: Record<string, string> = {
  six: "gitSix",
  lookup: "gitLookup",
  dispose: "gitDispose",
};
assert.ok(page in entryNames, `unknown page ${page}`);
const bunGuest = process.env.GIT_BUN_GUEST;
if (page !== "dispose")
  assert.ok(
    bunGuest && resolve(bunGuest) === bunGuest,
    "GIT_BUN_GUEST must be the absolute published bun.wasm path",
  );
const bashSource = process.env.GIT_BASH_SOURCE;
const shellGuest = process.env.GIT_SHELL_GUEST;
if (page === "lookup")
  assert.ok(
    bashSource && shellGuest,
    "lookup needs GIT_BASH_SOURCE and GIT_SHELL_GUEST absolute paths",
  );
const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(process.env.GIT_SCRATCH ?? "/work/tmp", "git-six-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
const cleanup = async () => {
  await browser?.close();
  server?.stop(true);
  await rm(scratch, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void cleanup().finally(() => process.exit(1)));
try {
  const entry = entryNames[page];
  const workers =
    page === "dispose" ? [] : page === "lookup" ? ["worker", "shell-worker"] : ["worker"];
  const entries = [entry, "fs-worker"].concat(workers);
  const built = await Bun.build({
    entrypoints: entries.map((name) => join(root, "tests/browser", `${name}.ts`)),
    outdir: scratch,
    target: "browser",
    format: "esm",
    splitting: true,
    plugins: [
      {
        name: "staged-bash-web",
        setup(builder) {
          builder.onResolve({ filter: /^bash-web(\/worker)?$/ }, (args) => ({
            path: join(
              bashSource!,
              args.path === "bash-web" ? "src/index.ts" : "src/runtime/worker.ts",
            ),
          }));
        },
      },
    ],
  });
  assert.ok(built.success, built.logs.map(String).join("\n"));
  await writeFile(
    join(scratch, "index.html"),
    `<!doctype html><script type="module" src="/${entry}.js"></script>`,
  );
  const files: Record<string, string> = {
    "/git-cli.js": join(root, "dist/git-cli.js"),
    "/dist/git-cli.js": join(root, "dist/git-cli.js"),
    "/network.wasm": join(root, "node_modules/waffle/browser/net/network.wasm"),
  };
  if (bunGuest) files["/bun.wasm"] = bunGuest;
  if (shellGuest) files["/shell-engine.wasm"] = shellGuest;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "no-store",
      };
      const pathname = new URL(request.url).pathname;
      const path =
        files[pathname] ?? resolve(scratch, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!files[pathname] && !path.startsWith(scratch + sep))
        return new Response(null, { status: 403, headers });
      const file = Bun.file(path);
      if (!(await file.exists())) {
        console.error(JSON.stringify({ missing: pathname }));
        return new Response(null, { status: 404, headers });
      }
      return new Response(file, { headers });
    },
  });
  browser = await chromium.launch({ headless: true });
  const tab = await browser.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  tab.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await tab.goto(`http://127.0.0.1:${server.port}/`);
  const name = globals[page];
  await tab.waitForFunction((name) => Reflect.has(globalThis, name), name);
  const result = await tab.evaluate((name) => Reflect.get(globalThis, name)(), name);
  console.log(JSON.stringify({ browser: browser.version(), result, errors }, null, 1));
  assert.equal(result.ok, true, result.error);
  if (page === "six") assert.equal(await tab.locator("body").getAttribute("data-disposed"), "true");
  if (page === "lookup") checkLookup(result);
  if (page === "dispose")
    assert.deepEqual(result.results, {
      untouched: { entry: null, optTarget: null },
      "moved script behind a symlink": { entry: "symlink", optTarget: "file" },
      "new file with identical bytes": { entry: "file", optTarget: null },
      directory: { entry: "dir", optTarget: null },
      "changed bytes": { entry: "file", optTarget: null },
    });
  assert.deepEqual(errors, []);
} finally {
  await cleanup();
  console.log(
    JSON.stringify({
      cleanup: { scratchRemoved: true, browserClosed: true, listenerStopped: true },
    }),
  );
}

type Spawned = { argv: string[]; cwd: string; status: number; stdout: string; stderr: string };

function checkLookup(result: {
  bash: { exit: number; screen: string };
  bun: { status: number; stdout: string; stderr: string };
  heads: { bash: string; bun: string };
}) {
  const screen = result.bash.screen.replaceAll("\r\n", "\n");
  assert.equal(result.bash.exit, 0, screen);
  for (const line of [
    "/usr/bin/git\nShared commit\nlog=0\n",
    "subject=[Shared commit]\n",
    "init=0\n",
    "git: Could not find git root for /.\nstatus=128\n",
  ])
    assert.ok(screen.includes(line), `bash screen lacks ${JSON.stringify(line)}: ${screen}`);
  assert.equal(result.bun.status, 0, result.bun.stderr);
  const spawned: Spawned[] = JSON.parse(result.bun.stdout);
  assert.deepEqual(
    spawned.map(({ status, stdout }) => ({ status, stdout })),
    [
      { status: 0, stdout: "Shared commit\n" },
      { status: 0, stdout: "" },
      { status: 128, stdout: "" },
    ],
  );
  assert.equal(spawned[2].stderr, "git: Could not find git root for /.\n");
  assert.deepEqual(result.heads, { bash: "ref: refs/heads/main\n", bun: "ref: refs/heads/main\n" });
}
