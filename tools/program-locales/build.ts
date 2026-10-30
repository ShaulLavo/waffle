import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { finishProgramLocaleBuild } from "./prepare.ts";

const [program, stableTarget, ...args] = process.argv.slice(2);
assert.ok(program && stableTarget && args.length, "Missing locale Cargo transaction arguments");
execFileSync("cargo", args, { stdio: "inherit", env: process.env });
finishProgramLocaleBuild(process.env, stableTarget, program);
