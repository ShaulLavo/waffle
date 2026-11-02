import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { validateProgramDerivation } from "../../../tools/program-derivation.ts";
import { packageRoot } from "./build-config.ts";
import { sourceLock } from "./source-lock.ts";

const receipt: unknown = JSON.parse(
  readFileSync(resolve(packageRoot, "dist/awk.sizes.json"), "utf8"),
);
assert.ok(
  receipt &&
    typeof receipt === "object" &&
    "revision" in receipt &&
    "archiveSha256" in receipt &&
    "patchSha256" in receipt,
);
assert.equal(receipt.revision, sourceLock.upstream.revision);
assert.equal(receipt.archiveSha256, sourceLock.upstream.archiveSha256);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  receipt.patchSha256,
  sha256(readFileSync(resolve(packageRoot, "patches/wasi-unsupported-ops.patch"))),
);
assert.ok("stripped" in receipt && "brotli" in receipt && "gzip" in receipt);
function verify(name: string, entry: unknown): Buffer {
  assert.ok(entry && typeof entry === "object" && "bytes" in entry && "sha256" in entry);
  const bytes = readFileSync(resolve(packageRoot, "dist", name));
  assert.equal(bytes.length, entry.bytes, name);
  assert.equal(sha256(bytes), entry.sha256, name);
  return bytes;
}
const stripped = verify("awk.wasm", receipt.stripped);
const brotli = verify("awk.wasm.br", receipt.brotli);
const gzip = verify("awk.wasm.gz", receipt.gzip);
const derivation: unknown = JSON.parse(
  readFileSync(resolve(packageRoot, "dist/awk-program.json"), "utf8"),
);
validateProgramDerivation(derivation, stripped);
assert.deepEqual(gunzipSync(gzip), stripped, "Gzip serves exactly the final program");
assert.deepEqual(
  brotliDecompressSync(brotli),
  stripped,
  "Brotli serves exactly the stripped program",
);
console.log(
  "Verified awk source and current finalizer receipts, final payload, and compressed identities",
);
