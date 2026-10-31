import { expect, test } from "bun:test";
import { planGrep } from "../../grep/src/plan.ts";
import { planRg } from "../../ripgrep/src/plan.ts";

const aliases = [
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/21",
  "/proc/self/fd/0",
  "/dev/./fd/0",
  "/proc/self/fd/../fd/0",
];
const relative = [
  { PWD: "/dev", path: "stdin" },
  { PWD: "/dev/fd", path: "./0" },
  { PWD: "/proc/self", path: "fd/0" },
];

for (const { PWD, path } of aliases.map((path) => ({ PWD: "/", path })).concat(relative)) {
  test(`both planners leave process-local operand ${PWD} ${path} on WASM`, () => {
    const env = { PWD, LC_ALL: "C" };
    expect(planGrep(["-racHF", "needle", path], env).kind).toBe("fallback");
    expect(
      planRg(["--color", "never", "--no-ignore", "--hidden", "--text", "-cHF", "needle", path], env)
        .kind,
    ).toBe("fallback");
  });
}
