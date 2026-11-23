import { expect, test } from "bun:test";
import { posix, resolve } from "node:path";
import { readFileSync } from "node:fs";

// A published file may only import or path-load other published files. The helpers behind
// `./testing/*` live in `testing/`; this check keeps them (and everything else that ships)
// from reaching back into `tests/` or any other directory the package leaves out.
const root = resolve(import.meta.dir, "..");
const packed = Bun.spawnSync(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"], { cwd: root });
if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
const published = new Set(
  Array.from(
    packed.stdout.toString().matchAll(/^packed \S+ (.+)$/gm),
    (match) => match[1] as string,
  ),
);
// `dist/` is emitted by prepare and `.build/` holds tools downloaded at run time.
const generated = /^dist\/|(?:^|\/)\.build\//;

function isPublished(path: string): boolean {
  if (generated.test(path) || published.has(path)) return true;
  const directory = path.endsWith("/") ? path : `${path}/`;
  return Array.from(published).some((entry) => entry.startsWith(directory));
}

function targets(from: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  return [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`];
}

const importPatterns = [
  /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s+["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\.meta\.resolve\(\s*["'](\.{1,2}\/[^"']+)["']/g,
  /\bnew\s+URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g,
];
const directoryPattern =
  /\b(?:join|resolve)\(\s*import\.meta\.(?:dir|dirname)\s*,((?:\s*["'][^"']*["']\s*,?)+)\)/g;

function referencedPaths(file: string, rawSource: string): string[] {
  const source = rawSource
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join("\n");
  const found: string[] = [];
  for (const pattern of importPatterns)
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  for (const match of source.matchAll(directoryPattern)) {
    const parts = Array.from((match[1] as string).matchAll(/["']([^"']*)["']/g), (part) => part[1]);
    found.push(posix.join(".", ...(parts as string[])));
  }
  return found.map((specifier) => {
    const candidates = targets(file, specifier);
    if (candidates[0] === ".") return "";
    const hit = candidates.find((candidate) => isPublished(candidate));
    return hit === undefined ? candidates[0]! : "";
  });
}

test("the package lists no tests directory", () => {
  expect(Array.from(published).filter((path) => path.startsWith("tests/"))).toEqual([]);
  expect(published.has("testing/page-runner/consumer.ts")).toBe(true);
});

test("published source imports and path-loads only published files", () => {
  const missing: string[] = [];
  for (const file of published) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const source = readFileSync(resolve(root, file), "utf8");
    for (const path of referencedPaths(file, source))
      if (path !== "") missing.push(`${file} -> ${path}`);
  }
  expect(missing).toEqual([]);
});

test("every exported source target is published", () => {
  const manifest: { exports: Record<string, Record<string, string>> } = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const missing: string[] = [];
  for (const [key, entry] of Object.entries(manifest.exports))
    for (const target of Object.values(entry)) {
      const path = target.replace(/^\.\//, "");
      if (!isPublished(path)) missing.push(`${key} -> ${path}`);
    }
  expect(missing).toEqual([]);
});
