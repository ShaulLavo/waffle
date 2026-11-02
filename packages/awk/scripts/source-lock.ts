import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "./build-config.ts";

const lock: unknown = JSON.parse(readFileSync(resolve(packageRoot, "sources.lock.json"), "utf8"));
assert.ok(lock && typeof lock === "object" && "upstream" in lock);
const upstream = lock.upstream;
assert.ok(upstream && typeof upstream === "object");
assert.ok(
  "revision" in upstream &&
    typeof upstream.revision === "string" &&
    /^[a-f0-9]{40}$/.test(upstream.revision),
);
assert.ok(
  "archiveSha256" in upstream &&
    typeof upstream.archiveSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(upstream.archiveSha256),
);
assert.ok(
  "licenseSha256" in upstream &&
    typeof upstream.licenseSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(upstream.licenseSha256),
);
assert.ok("archive" in upstream && typeof upstream.archive === "string");
assert.equal(
  upstream.archive,
  `https://codeload.github.com/onetrueawk/awk/tar.gz/${upstream.revision}`,
);
export const sourceLock = {
  upstream: {
    revision: upstream.revision,
    archive: upstream.archive,
    archiveSha256: upstream.archiveSha256,
    licenseSha256: upstream.licenseSha256,
  },
};
