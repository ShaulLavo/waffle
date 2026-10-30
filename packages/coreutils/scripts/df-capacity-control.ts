import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { dfBuildEnvironment } from "./build-df.ts";
import { verifyWasiGuest } from "../../../tools/program-build-tools.ts";
import { programCOptimizationFlags } from "../../../tools/program-optimize.ts";

const { env, configuration } = dfBuildEnvironment();
assert.ok(env.CARGO_TARGET_DIR);
const output = resolve(env.CARGO_TARGET_DIR, "../df-statvfs.wasm");
execFileSync(
  configuration.linker,
  ["--target=wasm32-wasip1", `--sysroot=${configuration.sysroot}`].concat(
    programCOptimizationFlags,
    [
      "-Wl,--max-memory=268435456",
      resolve(import.meta.dirname, "../fixtures/df-statvfs.c"),
      "-o",
      output,
    ],
  ),
  { env, stdio: "inherit", timeout: 30_000, killSignal: "SIGTERM" },
);
verifyWasiGuest(output);
execFileSync(
  process.execPath,
  ["test", resolve(import.meta.dirname, "../tests/df-capacity.test.ts")],
  {
    env: { ...env, DF_CAPACITY_GUEST: output },
    stdio: "inherit",
    timeout: 30_000,
    killSignal: "SIGTERM",
  },
);
