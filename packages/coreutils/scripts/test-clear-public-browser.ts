import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../../..");
const releaseURL = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.2";
const manifestSHA = "454b0d50c2e3af6ab9b12cd0011bf1d50b58a986234e8f1c0d87d6da85d74196";
const runtimeURL =
  "https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.93/waffle-0.0.93.tgz";
const runtimeSHA = "901243b1969de48b70c6adb5a7897e7c3d679b28e689c33149df5b8b433d9262";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function download(url: string, destination: string, expected: string) {
  execFileSync("curl", ["-fsSL", "--max-time", "45", "--output", destination, url], {
    stdio: "inherit",
  });
  const bytes = await readFile(destination);
  assert.equal(digest(bytes), expected, `checksum ${url}`);
  console.log(JSON.stringify({ artifact: url, bytes: bytes.length, sha256: digest(bytes) }));
}

async function stage(consumer: string) {
  const manifestFile = resolve(consumer, "program-release.json");
  await download(`${releaseURL}/program-release.json`, manifestFile, manifestSHA);
  const manifest: unknown = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.ok(
    manifest &&
      typeof manifest === "object" &&
      "packages" in manifest &&
      Array.isArray(manifest.packages),
  );
  const family = manifest.packages.find(
    (entry: unknown) =>
      entry && typeof entry === "object" && "name" in entry && entry.name === "waffle-coreutils",
  );
  assert.ok(
    family &&
      typeof family.url === "string" &&
      typeof family.sha256 === "string" &&
      Array.isArray(family.artifacts),
  );
  const guest = family.artifacts.find(
    (entry: unknown) =>
      entry && typeof entry === "object" && "path" in entry && entry.path === "dist/clear.wasm",
  );
  assert.ok(guest && typeof guest.sha256 === "string");
  const runtimeArchive = resolve(consumer, "waffle.tgz");
  const coreutilsArchive = resolve(consumer, "coreutils.tgz");
  await download(runtimeURL, runtimeArchive, runtimeSHA);
  await download(family.url, coreutilsArchive, family.sha256);
  const dependencies = {
    waffle: `file:${runtimeArchive}`,
    "waffle-coreutils": `file:${coreutilsArchive}`,
    playwright: "1.64.1",
  };
  await writeFile(
    resolve(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
      overrides: { waffle: dependencies.waffle },
    }),
  );
  execFileSync("bun", ["install", "--ignore-scripts"], {
    cwd: consumer,
    stdio: "inherit",
    timeout: 90000,
  });
  const installedGuest = await readFile(
    resolve(consumer, "node_modules/waffle-coreutils/dist/clear.wasm"),
  );
  assert.equal(digest(installedGuest), guest.sha256, "installed published clear readback");
  console.log(
    JSON.stringify({
      installedClearBytes: installedGuest.length,
      installedClearSHA256: digest(installedGuest),
    }),
  );
  const copies = [
    "packages/coreutils/tests/clear-public-browser-app.ts",
    "tools/program-test-root.ts",
    "tools/test-assert.ts",
  ];
  for (const path of copies) {
    const destination = resolve(consumer, path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(resolve(repository, path), destination);
    console.log(JSON.stringify({ source: path, sha256: digest(await readFile(destination)) }));
  }
  for (const path of [
    "waffle-coreutils/src/index.ts",
    "waffle/index.ts",
    "waffle/browser/preview1-worker.ts",
  ])
    console.log(
      JSON.stringify({
        installedSource: path,
        sha256: digest(await readFile(resolve(consumer, "node_modules", path))),
      }),
    );
}

async function browserCampaign(consumer: string, owned: AsyncDisposableStack) {
  const runtime = resolve(consumer, "node_modules/waffle");
  const {
    BrowserRunnerLifecycle,
  }: typeof import("../../waffle/tests/browser-runner-lifecycle.ts") = await import(
    resolve(runtime, "tests/browser-runner-lifecycle.ts")
  );
  const resources = new BrowserRunnerLifecycle(120000);
  owned.defer(() => resources.close());
  try {
    await resources.init("/work/tmp");
    console.log(JSON.stringify({ browserScratch: resources.scratch }));
    const output = resolve(consumer, "bundle");
    const build = await Bun.build({
      entrypoints: [
        resolve(consumer, "packages/coreutils/tests/clear-public-browser-app.ts"),
        resolve(runtime, "browser/fs-worker.ts"),
        resolve(runtime, "browser/preview1-worker.ts"),
      ],
      outdir: output,
      target: "browser",
      naming: "[name].js",
    });
    assert.ok(build.success, String(build.logs));
    const requests: unknown[] = [];
    const url = resources.serve(
      {
        "/": '<!doctype html><body><script type="module" src="/app.js"></script>',
        "/app.js": Bun.file(resolve(output, "clear-public-browser-app.js")),
        "/fs-worker.js": Bun.file(resolve(output, "fs-worker.js")),
        "/preview1-worker.js": Bun.file(resolve(output, "preview1-worker.js")),
        "/dist/clear.wasm": Bun.file(
          resolve(consumer, "node_modules/waffle-coreutils/dist/clear.wasm"),
        ),
      },
      0,
      () => (event) => {
        requests.push(event);
      },
    );
    const browser = await resources.launch("chromium");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) =>
      console.log(JSON.stringify({ browserConsole: message.type(), text: message.text() })),
    );
    const workerClosures: Promise<unknown>[] = [];
    page.on("worker", (worker) => workerClosures.push(worker.waitForEvent("close")));
    await page.goto(url);
    await page.waitForSelector('body[data-done="true"]', { timeout: 90000 });
    const result: unknown = JSON.parse(await page.locator("body").innerText());
    console.log(
      JSON.stringify({
        engine: "Chromium",
        version: browser.version(),
        result,
        requests,
        errors,
        disposed: await page.locator("body").getAttribute("data-disposed"),
      }),
    );
    assert.ok(result && typeof result === "object" && "ok" in result && result.ok === true);
    assert.equal(await page.locator("body").getAttribute("data-disposed"), "true");
    assert.deepEqual(errors, []);
    await Promise.all(workerClosures);
    assert.equal(page.workers().length, 0, "workers remain after runtime disposal");
    console.log(
      JSON.stringify({ browserWorkersAfterDispose: page.workers().length, passed: true }),
    );
  } finally {
    await resources.close();
  }
}

await mkdir("/work/tmp", { recursive: true });
const consumer = await mkdtemp("/work/tmp/waffle-clear-public-");
console.log(JSON.stringify({ ownedConsumer: consumer }));
const owned = new AsyncDisposableStack();
owned.defer(() => rm(consumer, { recursive: true, force: true }));
const interrupted = () => {
  void owned.disposeAsync().finally(() => process.exit(143));
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  await stage(consumer);
  await browserCampaign(consumer, owned);
} finally {
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  await owned.disposeAsync();
  console.log(JSON.stringify({ removedConsumer: consumer }));
}
