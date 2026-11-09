import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function workflowFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? workflowFiles(path) : [path];
  });
}

test("CI release downloads cannot use public-only setup actions or curl", () => {
  const findings = workflowFiles(join(root, ".github")).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return text.split("\n").flatMap((line, index) =>
      /uses:\s*(?:oven-sh\/setup-bun|actions\/setup-node|mozilla-actions\/sccache-action|bytecodealliance\/actions\/wasmtime\/setup)@/.test(line) ||
      /curl[^\n]*https:\/\/github\.com\/[^\s]+\/releases\/download\//.test(line)
        ? [`${path.slice(root.length)}:${index + 1}: ${line.trim()}`]
        : [],
    );
  });
  expect(findings).toEqual([]);
});
