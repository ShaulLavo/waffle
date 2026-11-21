import { verifyPackedSearchHooks } from "./search-packed-hooks.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CommandCleanupError } from "../packages/waffle/scripts/owned-command.ts";

const root = resolve(import.meta.dirname, "..");
const [flag, browser, extra] = process.argv.slice(2);
assert.ok(
  flag === undefined || (flag === "--workload" && browser && !extra),
  "Usage: bun run programs:packed [--workload chromium|firefox|webkit]",
);
const temporary = resolve(process.env.PROGRAM_CONSUMER_SCRATCH ?? "/work/tmp");
await mkdir(temporary, { recursive: true });
const consumer = await mkdtemp(resolve(temporary, "waffle-programs-packed-"));
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Packed workload interrupted"));
if (browser) {
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
}
let retained = false;
try {
  const runtimeArchive = resolve(consumer, "waffle-runtime-local.tgz");
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", runtimeArchive], {
    cwd: resolve(root, "packages/waffle"),
    stdio: "pipe",
  });
  const taskLocalRuntimeArchiveSHA256 = createHash("sha256")
    .update(new Uint8Array(await Bun.file(runtimeArchive).arrayBuffer()))
    .digest("hex");
  if (!browser) console.log(JSON.stringify({ taskLocalRuntimeArchiveSHA256 }));
  const files: Record<string, string> = { "@waffle-os/runtime": `file:${runtimeArchive}` };
  const families = browser
    ? ["coreutils"]
    : ["base", "coreutils", "findutils", "grep", "ripgrep", "sed"];
  for (const family of families) {
    const directory = resolve(root, "packages", family);
    const manifest: unknown = await Bun.file(resolve(directory, "package.json")).json();
    assert.ok(
      manifest && typeof manifest === "object" && "name" in manifest && "version" in manifest,
    );
    assert.ok(typeof manifest.name === "string" && typeof manifest.version === "string");
    const archiveName = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
    files[manifest.name] = `file:${resolve(directory, ".build", archiveName)}`;
  }
  await writeFile(
    resolve(consumer, "package.json"),
    JSON.stringify(
      { private: true, type: "module", dependencies: files, overrides: files },
      null,
      2,
    ),
  );
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: consumer, stdio: "inherit" });
  if (browser) {
    const { runAcceptance } = await import("../scripts/program-release.ts");
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const acceptance = await runAcceptance(
      resolve(root, "tools/family-workload.ts"),
      consumer,
      Object.keys(files),
      process.env,
      { timeoutMs: 240_000, signal: controller.signal },
      root,
      browser,
    );
    const coreutils = files["@waffle-os/coreutils"]!;
    const coreutilsArchiveSha256 = createHash("sha256")
      .update(new Uint8Array(await Bun.file(coreutils.slice("file:".length)).arrayBuffer()))
      .digest("hex");
    console.log(
      JSON.stringify({
        sourceCommit,
        taskLocalRuntimeArchiveSHA256,
        coreutilsArchiveSha256,
        acceptance,
      }),
    );
  } else {
    await verifyFamilies(consumer, files);
  }
} catch (error) {
  retained = error instanceof CommandCleanupError;
  if (retained) console.error("Retained packed consumer at " + consumer);
  throw error;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (!retained) await rm(consumer, { recursive: true, force: true });
}

async function verifyFamilies(consumer: string, files: Record<string, string>) {
  await verifyPackedSearchHooks(consumer);
  const entry = resolve(consumer, "acceptance.js");
  const bundle = await Bun.build({
    entrypoints: [resolve(root, "tools/family-packed-app.ts")],
    outdir: consumer,
    naming: "acceptance.js",
    target: "bun",
    external: Object.keys(files).concat(["@waffle-os/runtime/*"]),
  });
  assert.ok(bundle.success, String(bundle.logs));
  execFileSync("bun", [entry], { cwd: consumer, stdio: "inherit", timeout: 90_000 });
}
