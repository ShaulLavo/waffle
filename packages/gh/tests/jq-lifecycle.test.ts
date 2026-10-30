import assert from "node:assert/strict";
import { test } from "node:test";
import { GhError } from "../src/errors.ts";
import { executeJq } from "../src/jq.ts";

test("jq early exit rejects without an unhandled stdin EPIPE", async () => {
  await assert.rejects(
    executeJq(
      ".[",
      Array.from({ length: 200000 }, () => "fixture"),
      { cwd: "/", env: {} },
    ),
    (error) => {
      assert.ok(error instanceof GhError);
      assert.match(error.message, /failed to evaluate jq expression/);
      assert.match(error.message, /parse|compile|unexpected/i);
      return true;
    },
  );
});
