import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [, , guest, preopen] = process.argv;
assert.ok(guest && preopen, "Expected a guest module and host preopen directory");
const runner = resolve(import.meta.dirname, "../../../../tools/program-wasi-command.ts");
const result = spawnSync(
  "node",
  [
    "--disable-warning=ExperimentalWarning",
    runner,
    "--cwd",
    "/workspace/深",
    "--argv0",
    "/guest/bin/probe",
    "--dir",
    `/workspace=${preopen}`,
    "--env",
    "PWD=/decoy",
    "--",
    guest,
    "first argument",
    "--guest-flag",
  ],
  {
    encoding: "utf8",
    input: "from host\n",
    env: { ...process.env, WAFFLE_HOST_ONLY: "outside the guest" },
    timeout: 30_000,
  },
);
if (result.error) throw result.error;
assert.equal(result.status, 37, result.stderr);
assert.equal(result.stdout, "cwd harness passed\n");
assert.equal(result.stderr, "guest stderr\n");
console.log("Node WASI command harness passed its compiled guest checks");
