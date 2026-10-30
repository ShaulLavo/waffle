#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { patchBuildScript, sha256 } from "./patch.ts";

const [compiler, ...args] = process.argv.slice(2);
assert.ok(compiler, "Missing real Rust compiler");
const sourceIndex = args.findIndex((arg) => arg.endsWith("build.rs"));
if (process.env.CARGO_PKG_NAME === "uucore" && sourceIndex !== -1) {
  assert.ok(process.env.WAFFLE_PROGRAM_LOCALE_INPUTS, "Missing single-program catalog selection");
  const source = args[sourceIndex];
  assert.ok(source);
  const version = process.env.CARGO_PKG_VERSION ?? "";
  const patched = patchBuildScript(
    readFileSync(source, "utf8"),
    version,
    resolve(import.meta.dirname, "generate.rs"),
    resolve(import.meta.filename),
  );
  const directory = resolve(process.env.WAFFLE_PROGRAM_LOCALE_INPUTS, "sources", sha256(patched));
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "build.rs");
  if (!existsSync(path) || readFileSync(path, "utf8") !== patched) {
    const temporary = `${path}.${process.pid}`;
    writeFileSync(temporary, patched);
    renameSync(temporary, path);
  }
  writeFileSync(
    resolve(directory, "source.json"),
    JSON.stringify(
      {
        upstreamBuildScriptSha256: sha256(readFileSync(source)),
        patchedBuildScriptSha256: sha256(patched),
        version,
        generatorSha256: sha256(readFileSync(resolve(import.meta.dirname, "generate.rs"))),
      },
      null,
      2,
    ),
  );
  args[sourceIndex] = path;
}
const stdio: Array<"inherit" | "ignore" | number> = ["inherit", "inherit", "inherit"];
const jobserver = process.env.CARGO_MAKEFLAGS?.match(/--jobserver-(?:auth|fds)=(\d+),(\d+)/);
for (const value of jobserver?.slice(1) ?? []) {
  const fd = Number(value);
  while (stdio.length <= fd) stdio.push("ignore");
  stdio[fd] = fd;
}
const child = spawnSync(compiler, args, { stdio, env: process.env });
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
