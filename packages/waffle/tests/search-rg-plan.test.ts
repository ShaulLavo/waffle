import { expect, test } from "bun:test";
import { planRg } from "../../ripgrep/src/plan.js";

const required = ["--color", "never", "--no-ignore", "--hidden", "--text"];
const workloads = [
  ["-c", "-F", "--glob", "*.tsx", "--glob", "!node_modules/**", "--", "export", "."],
  ["-c", "-i", "--glob", "*.js", "--", "workUnitAsyncStorage|createServer", "."],
  ["-c", "-F", "--glob", "*.js", "--", "search_lane_absent_729f3d", "."],
  ["-c", "-F", "--glob", "*.js", "--", "require", "."],
  ["-l", "-F", "--glob", "*.js", "--", "workUnitAsyncStorage", "."],
];

for (const argv of workloads) {
  test(`admits frozen workload ${argv.at(-2)}`, () => {
    const result = planRg(required.concat(argv));
    expect(result.kind).toBe("supported");
    if (result.kind === "fallback") throw new Error(result.reason);
    expect(result.plan.tool).toBe("rg");
    expect(result.plan.operands).toEqual(["."]);
    expect(result.plan.output.kind).toBe(argv[0] === "-l" ? "files-with-matches" : "count");
    expect(result.plan.walk.hidden).toBe(true);
  });
}

test("option clusters consume attached values and later output switches win", () => {
  const result = planRg(required.concat(["-lcnNiFHeone", "-e", "two", "--", "."]));
  expect(result.kind).toBe("supported");
  if (result.kind === "fallback") throw new Error(result.reason);
  expect(result.plan.matcher).toEqual({ kind: "literal", patterns: ["one", "two"], ignoreCase: true });
  expect(result.plan.output).toEqual({ kind: "count", zeroCounts: false, withFilename: true });
});

test("unproved patterns and unsupported options fall back without mutating argv or env", () => {
  const env = Object.freeze({ RIPGREP_CONFIG_PATH: "", LANG: "C" });
  for (const tail of [["a.*", "."], ["-u", "hit", "."], ["hit", "-"], ["hit"]]) {
    const argv = Object.freeze(required.concat(tail));
    expect(planRg(argv, env).kind).toBe("fallback");
    expect(argv).toEqual(required.concat(tail));
    expect(env).toEqual({ RIPGREP_CONFIG_PATH: "", LANG: "C" });
  }
});
