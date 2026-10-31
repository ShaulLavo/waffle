import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { readProgramLocaleProof } from "./prepare.ts";
import { sha256 } from "./patch.ts";
import { selectCatalogs } from "./selection.ts";

test("a catalog proof cannot relabel other bytes or the wrong utility selection", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "waffle-locale-proof-"));
  try {
    const path = resolve(directory, "echo.wasm");
    const bytes = "compiler-output-fixture";
    writeFileSync(path, bytes);
    const keys = selectCatalogs("echo", "0.13.0");
    const source = keys.map((key) => `        "${key}" => Some("catalog"),\n`).join("");
    const proof = {
      program: "echo",
      originalGuest: { sha256: sha256(bytes) },
      generated: [{ version: "0.13.0", keys, sha256: sha256(source), source }],
    };
    writeFileSync(`${path}.locales.json`, JSON.stringify(proof));
    readProgramLocaleProof(path, "echo");
    proof.generated[0]!.source = source.replace("catalog", "relabeled");
    writeFileSync(`${path}.locales.json`, JSON.stringify(proof));
    assert.throws(() => readProgramLocaleProof(path, "echo"), /Generated locale source changed/);
    proof.generated[0]!.source = source;
    proof.generated[0]!.keys = selectCatalogs("ls", "0.13.0");
    writeFileSync(`${path}.locales.json`, JSON.stringify(proof));
    assert.throws(() => readProgramLocaleProof(path, "echo"), /catalog selection differs/);
    proof.generated[0]!.keys = selectCatalogs("echo", "0.13.0");
    writeFileSync(`${path}.locales.json`, JSON.stringify(proof));
    writeFileSync(path, "other bytes");
    assert.throws(() => readProgramLocaleProof(path, "echo"), /producer bytes differ/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
