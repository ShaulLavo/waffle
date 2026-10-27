import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fixture from "./owned-fixtures/git-local.json" with { type: "json" };
import {
  mixedConflictExpected,
  indexOnlyStashExpected,
} from "../tests/helpers/git-review-cases.ts";

const directory = resolve(`.build/git-browser-${randomUUID()}`);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = resolve(directory, `.${path === "/" ? "/index.html" : path}`);
  if (!file.startsWith(directory + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});

try {
  await mkdir(directory, { recursive: true });
  await copyFile("dist/git-command.js", resolve(directory, "git-command.js"));
  const bundle = await build({
    entryPoints: {
      "git-tests": "tests/helpers/git-browser.ts",
      "fs-worker": "waffle/browser/fs-worker",
    },
    outdir: directory,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "esnext",
    chunkNames: "[name]-[hash]",
    metafile: true,
    plugins: [
      {
        name: "prepared-git",
        setup(builder) {
          builder.onResolve({ filter: /\/dist\/git-command\.js$/ }, () => ({
            path: "./git-command.js",
            external: true,
          }));
        },
      },
    ],
  });
  const assets = await Promise.all(
    Object.entries(bundle.metafile.outputs).map(async ([path, output]) => ({
      file: path.slice(path.lastIndexOf("/") + 1),
      bytes: output.bytes,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  const backend = await readFile(resolve(directory, "git-command.js"));
  assets.push({
    file: "git-command.js",
    bytes: backend.length,
    sha256: createHash("sha256").update(backend).digest("hex"),
  });
  await writeFile(
    resolve(directory, "index.html"),
    '<!doctype html><script type="module" src="/git-tests.js"></script>',
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  page = await browser.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => !!window.gitLocalTest);
  assert.deepEqual(await page.evaluate(() => window.gitLocalTest.setup()), {
    admissions: 0,
    disposed: false,
  });
  assert.equal(
    requests.some((url) => new URL(url).pathname === "/git-command.js"),
    false,
    "install loads no Git backend",
  );
  for (const example of fixture.cases) await replay(page, example);
  await trackedStash(page);
  const reviewRegressions = await page.evaluate(
    (env) => window.gitLocalTest.reviewRegressions(env),
    fixture.provenance.environment,
  );
  console.log(JSON.stringify({ reviewRegressions }));
  assert.deepEqual(reviewRegressions, {
    merge: mixedConflictExpected,
    stash: indexOnlyStashExpected,
  });
  assert.deepEqual(errors, []);
  assert.equal(
    requests.filter((url) => new URL(url).pathname === "/git-command.js").length,
    1,
    "first use shares one loaded backend",
  );
  const released = await page.evaluate(() => window.gitLocalTest.release());
  assert.deepEqual(released, {
    runtimeDisposed: false,
    admissions: 0,
    marker: false,
    admissionRejected: true,
    pendingOutputJoined: true,
    disposalShared: true,
    acceptedStatus: 0,
    reinstall: true,
  });
  console.log(
    JSON.stringify({
      browser: await browser.version(),
      fixture: "4d37209ff07add549a8c5d7620785c06a5132bf5",
      cases: fixture.cases.length,
      steps: fixture.cases.reduce((sum, value) => sum + value.steps.length, 0),
      lazyBackendLoads: 1,
      processAdmissions: 0,
      runtimeBorrowed: true,
      lifecycle: released,
      shellPATH: "blocked by P WASM-only program registration",
      reviewRegressions,
      trackedStash: "staged and unstaged bytes restored by pop --index",
      assets,
    }),
  );
} finally {
  try {
    await page?.evaluate(() => window.gitLocalTest?.cleanup());
  } finally {
    await browser?.close();
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    await rm(directory, { recursive: true, force: true });
  }
}

async function trackedStash(target: NonNullable<typeof page>) {
  const result = await target.evaluate(async (env) => {
    const api = window.gitLocalTest;
    const dir = "/git-stash";
    await api.repository(dir);
    const run = async (...argv: string[]) => {
      const result = await api.run(argv, dir, env);
      if (result.status !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr}`);
      return result;
    };
    await run("init");
    await api.write(`${dir}/story`, "base\n");
    await run("add", "story");
    await run("commit", "-m", "base");
    await api.write(`${dir}/story`, "stage\n");
    await run("add", "story");
    await api.write(`${dir}/story`, "stage\nwork\n");
    await run("stash", "push", "-m", "shelved");
    const clean = await api.snapshot(dir, { c1: { subject: "base", parents: [] } });
    await run("stash", "pop", "--index");
    const restored = await api.snapshot(dir, { c1: { subject: "base", parents: [] } });
    return { clean, restored };
  }, fixture.provenance.environment);
  assert.deepEqual(result.clean.files, { story: "base\n" });
  assert.equal(result.clean.status, "");
  assert.deepEqual(result.restored.files, { story: "stage\nwork\n" });
  assert.equal(result.restored.status, "MM story\n");
  assert.deepEqual(result.restored.stash, []);
}

async function replay(target: NonNullable<typeof page>, example: (typeof fixture.cases)[number]) {
  const dir = `/git-${example.id}`;
  await target.evaluate((dir) => window.gitLocalTest.repository(dir), dir);
  for (const [index, step] of example.steps.entries()) {
    const label = `${example.id} step ${index}: ${JSON.stringify(step.action)}`;
    const action = step.action;
    await actionStep(target, dir, action, step.expected, label);
    const actual = await target.evaluate(
      ({ dir, history }) => window.gitLocalTest.snapshot(dir, history),
      { dir, history: step.state.history },
    );
    assert.deepEqual(actual, step.state, label);
  }
}

async function actionStep(
  target: NonNullable<typeof page>,
  dir: string,
  action: (typeof fixture.cases)[number]["steps"][number]["action"],
  expected: (typeof fixture.cases)[number]["steps"][number]["expected"],
  label: string,
) {
  if (action.kind === "write") {
    assert.ok(action.path !== undefined && action.text !== undefined);
    return target.evaluate(({ path, text }) => window.gitLocalTest.write(path, text), {
      path: `${dir}/${action.path}`,
      text: action.text,
    });
  }
  if (action.kind === "remove")
    return target.evaluate((path) => window.gitLocalTest.remove(path), `${dir}/${action.path}`);
  assert.ok(action.argv && expected);
  const actual = await target.evaluate(
    ({ argv, dir, env }) => window.gitLocalTest.run(argv, dir, env),
    { argv: action.argv, dir, env: fixture.provenance.environment },
  );
  assert.equal(actual.status, expected.status, `${label}: ${actual.stderr}`);
  if (expected.stdout !== null)
    assert.equal(
      actual.stdout.replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, "index <old>..<new>"),
      expected.stdout,
      label,
    );
  if (expected.stderr !== null) assert.equal(actual.stderr, expected.stderr, label);
}
