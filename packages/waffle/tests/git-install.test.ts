import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("the repository root is a private workspace and the runtime package owns its exports", () => {
  const repository = resolve(import.meta.dir, "../../..");
  const root = JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8")) as {
    private?: boolean;
    workspaces?: string[];
    exports?: unknown;
  };
  const runtime = JSON.parse(
    readFileSync(resolve(repository, "packages/waffle/package.json"), "utf8"),
  ) as {
    name: string;
    version: string;
    exports: Record<string, unknown>;
  };
  expect(root.private).toBe(true);
  expect(root.workspaces).toEqual(["packages/*"]);
  expect(root.exports).toBeUndefined();
  expect(runtime.name).toBe("waffle");
  expect(runtime.version).toMatch(/^0\.0\.\d+$/);
  expect(Object.keys(runtime.exports)).toContain(".");
});
