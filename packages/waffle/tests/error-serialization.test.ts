import { expect, test } from "bun:test";
import { serializeError } from "./error-serialization.js";

test("nested aggregate children, causes, stacks and custom error fields survive JSON", () => {
  const leaf = Object.assign(new TypeError("socket closed"), { code: "EPIPE" });
  const nested = new AggregateError(
    [new Error("context close", { cause: leaf }), "raw child"],
    "nested cleanup",
    { cause: new Error("nested cause", { cause: { status: 503 } }) },
  );
  const error = new AggregateError(
    [nested, new Error("browser close", { cause: leaf })],
    "cleanup failed",
    { cause: new RangeError("outer cause") },
  );
  const json: unknown = JSON.parse(JSON.stringify(serializeError(error)));
  expect(json).toEqual({
    name: "AggregateError",
    message: error.message,
    stack: error.stack,
    cause: {
      name: "RangeError",
      message: "outer cause",
      stack: error.cause instanceof Error ? error.cause.stack : undefined,
    },
    errors: [
      {
        name: "AggregateError",
        message: nested.message,
        stack: nested.stack,
        cause: expect.objectContaining({
          name: "Error",
          message: "nested cause",
          cause: { status: 503 },
        }),
        errors: [
          expect.objectContaining({
            message: "context close",
            cause: {
              name: "TypeError",
              message: leaf.message,
              stack: leaf.stack,
              code: "EPIPE",
            },
          }),
          "raw child",
        ],
      },
      expect.objectContaining({
        message: "browser close",
        cause: {
          name: "TypeError",
          message: leaf.message,
          stack: leaf.stack,
          code: "EPIPE",
        },
      }),
    ],
  });
});

test("deep causes are retained and actual cycles do not prevent JSON output", () => {
  const leaf = new Error("deepest cause", { cause: 123n });
  let error: Error = leaf;
  for (let index = 0; index < 10; index++) error = new Error(`wrapper ${index}`, { cause: error });
  const cyclic = new AggregateError([error], "cycle");
  cyclic.errors.push(cyclic);
  const json = JSON.stringify(serializeError(cyclic));
  expect(json).toContain('"message":"deepest cause"');
  expect(json).toContain('"cause":"123"');
  expect(json).toContain('"[circular]"');
});

test("an ordinary error can carry an aggregate cause with its own cause and children", () => {
  const cause = new AggregateError(
    [new Error("first child"), new Error("second child", { cause: new Error("child cause") })],
    "aggregate cause",
    { cause: new Error("aggregate root cause") },
  );
  const error = new Error("outer error", { cause });
  expect(JSON.parse(JSON.stringify(serializeError(error)))).toMatchObject({
    name: "Error",
    message: "outer error",
    cause: {
      name: "AggregateError",
      message: "aggregate cause",
      cause: { message: "aggregate root cause" },
      errors: [
        { message: "first child" },
        { message: "second child", cause: { message: "child cause" } },
      ],
    },
  });
});
