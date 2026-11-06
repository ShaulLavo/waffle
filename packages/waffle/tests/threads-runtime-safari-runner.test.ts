import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRuntimeSafariPacket,
  RUNTIME_SOURCE_COMMIT,
  RUNTIME_RECEIPT_SHA256,
  RUNTIME_FIXTURE_SHA256,
  runtimeSafariSources,
} from "./threads-runtime-safari-packet.ts";
import { runtimeSafariCases, runtimeSafariScript } from "./threads-runtime-safari-runner.ts";

async function rejectedPacket(assets: unknown, message: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "runtime-safari-packet-"));
  try {
    await Bun.write(
      join(directory, "manifest.json"),
      JSON.stringify({
        schema: 1,
        source: RUNTIME_SOURCE_COMMIT,
        sourceFiles: {},
        receiptSha256: RUNTIME_RECEIPT_SHA256,
        fixtureSha256: RUNTIME_FIXTURE_SHA256,
        assets,
        runnerSha256: "runner",
      }),
    );
    await expect(assertRuntimeSafariPacket(directory)).rejects.toThrow(message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Safari Runtime script executes exactly one selected case per document", () => {
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
    const script = runtimeSafariScript(selected);
    expect(script).toContain(`module.runThreadsRuntime(${JSON.stringify(selected)})`);
    expect(script).toContain("causalEvents");
    expect(script).not.toContain("for (");
    expect(script).not.toContain("while (");
  }
});

test("Runtime Safari packet rejects missing assets without a compiler or artifact", async () => {
  await rejectedPacket([], "asset allowlist mismatch");
});

test("Runtime Safari packet rejects duplicate allowlisted assets", async () => {
  await rejectedPacket(
    Array.from({ length: 6 }, () => ({
      path: "runtime-page.js",
      sha256: "digest",
    })),
    "asset allowlist mismatch",
  );
});

test("Runtime Safari packet rejects a path outside its six Runtime assets", async () => {
  const assets = Object.keys(runtimeSafariSources).map((path) => ({
    path: path.slice(1),
    sha256: "digest",
  }));
  assets[0] = { path: "../runtime-page.js", sha256: "digest" };
  await rejectedPacket(assets, "asset allowlist mismatch");
});
