import { expect, test } from "bun:test";
import { workspaceRequest } from "../fs/publication-workspace";
import { mutationIntent } from "../fs/publication";

const request = (operation: string, args: unknown[]) => ({
  operation,
  args,
  input: new Uint8Array(),
  id: { session: 1, sequence: 1 },
});

test("readonly workspace preopen is a path query without mutation identity", () => {
  const call = workspaceRequest(request("preopen", ["/", true]), 64, 1024);
  expect(call).toEqual({ operation: "preopen", args: ["/", true], input: new Uint8Array() });
  expect(mutationIntent(call.operation, call.args)).toBeUndefined();
});

test("readonly workspace preopen validates the path", () => {
  expect(() => workspaceRequest(request("preopen", [7, true]), 64, 1024)).toThrow(
    expect.objectContaining({ errno: 28 }),
  );
});

test("mutating workspace preopen retains its mutation identity", () => {
  const call = workspaceRequest(request("preopen", ["/created"]), 64, 1024);
  expect(call.id).toEqual({ session: 1, sequence: 1 });
  expect(mutationIntent(call.operation, call.args)).toBeDefined();
});

test("workspace queries remain an explicit allowlist", () => {
  expect(() => workspaceRequest(request("not-a-query", ["/"]), 64, 1024)).toThrow(
    expect.objectContaining({ errno: 2 }),
  );
});
