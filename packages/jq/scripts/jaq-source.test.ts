import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildJq, packageRoot } from "./build-jaq.ts";
import { jq } from "../src/index.ts";

const sourceLock = JSON.parse(readFileSync(resolve(packageRoot, "sources.lock.json"), "utf8"));

test("source archive and local adaptation are immutably pinned", () => {
  assert.match(sourceLock.upstream.revision, /^[0-9a-f]{40}$/);
  assert.match(sourceLock.upstream.archiveSha256, /^[0-9a-f]{64}$/);
  assert.ok(sourceLock.upstream.archive.endsWith(sourceLock.upstream.revision));
  assert.equal(sourceLock.upstream.version, "3.1.2");
  const patch = readFileSync(resolve(packageRoot, "patches/jaq-wasi.patch"), "utf8");
  const paths = Array.from(patch.matchAll(/^--- a\/(\S+)$/gm), (match) => match[1]);
  assert.deepEqual(paths, ["jaq/Cargo.toml", "jaq/src/funs.rs"]);
  assert.ok(patch.includes('cfg(not(target_os = "wasi"))'));
  assert.ok(patch.includes('cfg(target_os = "wasi")'));
});

test("catalog stays separately selectable and lazy", () => {
  assert.equal(jq.name, "jq");
  assert.equal(jq.programs[0]?.path, "/usr/bin/jq");
  assert.deepEqual(jq.programs[0]?.aliases, ["/bin/jq"]);
  assert.ok(jq.programs[0]?.wasm instanceof URL);
  assert.equal(jq.pick("/bin/jq").programs[0], jq.programs[0]);
});

test("build recipe uses the pinned portable WASI release path", async () => {
  let invocation: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  let verified = false;
  await buildJq({
    prepare: async () => {},
    execute: (command, args, options) => {
      invocation = { command, args, env: options.env };
    },
    environment: () => ({ INHERITED: "yes" }),
    verifier: () => {
      verified = true;
    },
  });
  assert.ok(invocation);
  assert.equal(invocation.command, "cargo");
  assert.ok(invocation.args.includes("--locked"));
  assert.ok(invocation.args.includes("--no-default-features"));
  assert.ok(invocation.args.includes(resolve(packageRoot, ".sources/jaq/Cargo.toml")));
  assert.equal(invocation.env.INHERITED, "yes");
  assert.equal(invocation.env.CARGO_PROFILE_RELEASE_OPT_LEVEL, "z");
  assert.equal(invocation.env.CARGO_PROFILE_RELEASE_LTO, "fat");
  assert.equal(invocation.env.CARGO_PROFILE_RELEASE_PANIC, "abort");
  assert.ok(verified);
});
