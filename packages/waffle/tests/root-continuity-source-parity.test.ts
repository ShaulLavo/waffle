import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

function replaceOnce(source: string, actual: string, original: string): string {
  if (source.split(actual).length !== 2) throw new Error(`Unexpected fixture delta: ${actual}`);
  return source.replace(actual, original);
}
function originalFixture(source: string): string {
  let restored = replaceOnce(
    source,
    'import type { RootContinuityStorage } from "./root-continuity-command.js";\n',
    "",
  );
  const acknowledgements =
    /^ *if \(storageHooks\) await storageHooks.allocate\(\{ kind: "indexeddb", name \}\);\n/gm;
  if (restored.match(acknowledgements)?.length !== 4) throw new Error("Wrong pre-open hook count");
  restored = restored.replace(acknowledgements, "");
  const deltas = [
    [
      "async function completedCheckpoint(name: string, storageHooks?: RootContinuityStorage) {",
      "async function completedCheckpoint(name: string) {",
    ],
    [
      "export async function selectedRootComposition(storageHooks?: RootContinuityStorage) {",
      "export async function selectedRootComposition() {",
    ],
    [
      "  const name = storageHooks?.name() ?? `root-continuity-${crypto.randomUUID()}`;",
      "  const name = `root-continuity-${crypto.randomUUID()}`;",
    ],
    [
      "  const saved = await completedCheckpoint(name, storageHooks);",
      "  const saved = await completedCheckpoint(name);",
    ],
    [
      'export async function startupFenceComposition(\n  mode: "cancel" | "failure",\n  storageHooks?: RootContinuityStorage,\n) {',
      'export async function startupFenceComposition(mode: "cancel" | "failure") {',
    ],
    [
      "  const name = storageHooks?.name() ?? `root-continuity-${mode}-${crypto.randomUUID()}`;",
      "  const name = `root-continuity-${mode}-${crypto.randomUUID()}`;",
    ],
  ];
  for (const [actual, original] of deltas) restored = replaceOnce(restored, actual!, original!);
  return restored;
}
function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
test("fixture differs from merged baseline only at four pre-open and two name sites", async () => {
  const source = await Bun.file(`${import.meta.dir}/root-continuity-browser.ts`).text();
  const baseline = "b989a831d826507690f175f175f1062747203f6fae7196a8b89a636865b7983a";
  expect(digest(originalFixture(source))).toBe(baseline);
  expect(
    digest(originalFixture(source.replace("error === failure", "error !== failure"))),
  ).not.toBe(baseline);
});
test("desktop command body and its 150000 ms lifecycle remain byte-identical", async () => {
  const source = await Bun.file(`${import.meta.dir}/root-continuity-browser-runner.ts`).text();
  const desktop = source.slice(source.indexOf("import { navigateTestPage }"));
  expect(digest(desktop)).toBe("00b0311ae7364830eb0a91fb1bccfc1d45f23b664370418d3108e353a9f84d83");
  const native = source.slice(
    0,
    source.indexOf('if (import.meta.main && process.argv[2] === "--page-controls")'),
  );
  expect(native.indexOf("const startedAt = performance.now();")).toBeLessThan(
    native.indexOf("await import("),
  );
  expect(native).toContain("{ startedAt }");
});
test("hosted controls are normal-discovered alongside the unchanged desktop command", async () => {
  const matrix = await Bun.file(`${import.meta.dir}/../scripts/test-browser.ts`).text();
  expect(matrix).toContain(
    'runner: "tests/root-continuity-browser-runner.ts", engines: ["chromium"]',
  );
  expect(matrix).toContain('engines: ["--page-controls", "chromium"]');
});
