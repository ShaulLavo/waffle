import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRuntimeSafariPacket,
  runtimeNativeSources,
  type RuntimeSafariManifest,
} from "./threads-runtime-safari-packet.ts";
import { runtimeSafariCases, runtimeSafariScript } from "./threads-runtime-safari-runner.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function packetControl(
  body: (directory: string, manifest: RuntimeSafariManifest) => Promise<void>,
) {
  const directory = await mkdtemp(
    join(process.env.PROCESS_SCRATCH_ROOT ?? process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "wtp-"),
  );
  try {
    const files = Object.keys(runtimeNativeSources).map((path) => path.slice(1));
    const assets = files.map((path) => ({ path, sha256: digest(path) }));
    for (const path of files.concat([
      "threads.wasm",
      "threads.receipt.json",
      "runner.mjs",
      "ios-runner.mjs",
    ]))
      await Bun.write(join(directory, path), path);
    const manifest: RuntimeSafariManifest = {
      schema: 1,
      source: "a".repeat(40),
      sourceFiles: { "packages/waffle/tests/threads-runtime-browser.ts": digest("source") },
      receiptSha256: digest("threads.receipt.json"),
      fixtureSha256: digest("threads.wasm"),
      assets,
      runnerSha256: digest("runner.mjs"),
      nativeRunnerSha256: digest("ios-runner.mjs"),
    };
    await Bun.write(join(directory, "manifest.json"), JSON.stringify(manifest));
    await body(directory, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Safari Runtime script executes exactly one typed case with verified fixture identity", () => {
  expect(runtimeSafariCases).toEqual([
    "pair",
    "repeat",
    "nested",
    "join",
    "child-exit",
    "kill-start",
    "cpu",
    "wait32",
    "wait64",
  ]);
  for (const selected of runtimeSafariCases) {
    const script = runtimeSafariScript(selected, "verified-fixture");
    expect(script).toContain(
      `module.runThreadsRuntime(${JSON.stringify(selected)}, false, "verified-fixture")`,
    );
    expect(script).toContain("causalEvents");
    expect(script).not.toContain("for (");
    expect(script).not.toContain("while (");
  }
});

test("portable packet validates current generated identity without a historical production pin", async () => {
  await packetControl(async (directory, manifest) => {
    expect(await assertRuntimeSafariPacket(directory, manifest)).toEqual(manifest);
    await expect(
      assertRuntimeSafariPacket(directory, { ...manifest, source: "b".repeat(40) }),
    ).rejects.toThrow("identity mismatch");
    await expect(
      assertRuntimeSafariPacket(directory, { ...manifest, fixtureSha256: digest("other") }),
    ).rejects.toThrow("identity mismatch");
    await expect(
      assertRuntimeSafariPacket(directory, { ...manifest, receiptSha256: digest("other") }),
    ).rejects.toThrow("identity mismatch");
    await expect(
      assertRuntimeSafariPacket(directory, { ...manifest, sourceFiles: {} }),
    ).rejects.toThrow("identity mismatch");
  });
});

for (const path of [
  "runtime-page.js",
  "threads.wasm",
  "threads.receipt.json",
  "runner.mjs",
  "ios-runner.mjs",
]) {
  test(`portable packet rejects changed ${path} bytes`, async () => {
    await packetControl(async (directory, manifest) => {
      await Bun.write(join(directory, path), "tampered");
      await expect(assertRuntimeSafariPacket(directory, manifest)).rejects.toThrow(
        "digest mismatch",
      );
    });
  });
}

for (const mode of ["missing", "duplicate", "outside"] as const) {
  test(`portable packet refuses ${mode} assets before execution`, async () => {
    await packetControl(async (directory, manifest) => {
      const assets = mode === "missing" ? [] : manifest.assets.slice();
      if (mode === "duplicate") assets[0] = assets[1]!;
      if (mode === "outside") assets[0] = { path: "../runtime-page.js", sha256: digest("other") };
      await Bun.write(join(directory, "manifest.json"), JSON.stringify({ ...manifest, assets }));
      await expect(assertRuntimeSafariPacket(directory, manifest)).rejects.toThrow(
        "asset allowlist mismatch",
      );
    });
  });
}
