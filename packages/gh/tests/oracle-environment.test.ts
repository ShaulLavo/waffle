import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonEnvironment } from "../scripts/oracle-environment.ts";

test("native comparisons inherit only the executable path, not automation or credentials", () => {
  assert.deepEqual(comparisonEnvironment({ root: "/fixture", authenticated: false }), {
    PATH: process.env.PATH,
    HOME: "/fixture",
    GH_CONFIG_DIR: "/fixture",
    NO_COLOR: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    LANG: "C.UTF-8",
  });
});

test("authenticated parser comparisons use only the explicit fake token", () => {
  const env = comparisonEnvironment({ root: "/fixture", authenticated: true });
  assert.equal(env.GH_TOKEN, "GH_CONTRACT_FAKE_TOKEN_NEVER_VALID");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.CI, undefined);
  assert.equal(env.GITHUB_ACTIONS, undefined);
});
