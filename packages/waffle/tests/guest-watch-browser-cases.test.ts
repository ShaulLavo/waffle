import { expect, test } from "bun:test";
import { guestWatchFailure } from "./guest-watch-browser-cases.js";

test("guest watch failure keeps its stage and cause message at the runner boundary", () => {
  const cause = new Error("watch delivery failed");
  const failure = guestWatchFailure("iteration 7", cause);
  const reported = structuredClone({ name: failure.name, message: failure.message });

  expect(reported).toEqual({
    name: "Error",
    message: "guest watch proof failed at iteration 7: watch delivery failed",
  });
  expect(failure.cause).toBe(cause);
});

test("guest watch failure formats non-Error throws without throwing", () => {
  const failure = guestWatchFailure("spawn", {
    toString() {
      throw new Error("conversion failed");
    },
  });

  expect(failure.message).toBe("guest watch proof failed at spawn: <non-Error thrown value>");
});
