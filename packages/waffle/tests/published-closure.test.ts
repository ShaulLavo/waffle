import { expect, test } from "bun:test";
import { posix, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

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

const directories = new Set<string>();
for (const entry of published)
  for (let at = entry.indexOf("/"); at !== -1; at = entry.indexOf("/", at + 1))
    directories.add(entry.slice(0, at));

function isPublished(path: string): boolean {
  if (generated.test(path) || published.has(path)) return true;
  return directories.has(path.endsWith("/") ? path.slice(0, -1) : path);
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
  // A bare "name.wasm" is relative to the importing file, like "./name.wasm".
  /\bnew\s+URL\(\s*["']((?![a-z][a-z0-9+.-]*:|\/)[^"']+)["']\s*,\s*import\.meta\.url/g,
  /\bimport\.meta\.(?:dir|dirname)\s*\+\s*["']\/([^"']+)["']/g,
  /\$\{import\.meta\.(?:dir|dirname)\}\/([^`"'$]+)/g,
];
const directoryPattern =
  /\b(?:join|resolve)\(\s*import\.meta\.(?:dir|dirname)\s*,((?:\s*["'][^"']*["']\s*,?)+)\)/g;

function referencedPaths(
  file: string,
  rawSource: string,
  available: (path: string) => boolean = isPublished,
): string[] {
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
    const hit = candidates.find((candidate) => available(candidate));
    return hit === undefined ? candidates[0]! : "";
  });
}

test("the scanner catches bare and dotted relative loads and accepts published ones", () => {
  const planted = [
    'new URL("missing.wasm", import.meta.url)',
    'new URL("./missing.wasm", import.meta.url)',
    'resolve(import.meta.dir, "missing.ts")',
    'join(import.meta.dirname, "..", "missing", "x.ts")',
    'import.meta.dir + "/missing.ts"',
    "`${import.meta.dir}/missing.ts`",
    'import("../tests/missing.ts")',
  ];
  for (const source of planted)
    expect(referencedPaths("browser/example.ts", source).filter(Boolean), source).not.toEqual([]);
  const allowed = [
    'new URL("worker.ts", import.meta.url)',
    'new URL("https://example.com/x", import.meta.url)',
    'resolve(import.meta.dir, "worker.ts")',
    'import("./worker.js")',
  ];
  for (const source of allowed)
    expect(referencedPaths("browser/example.ts", source).filter(Boolean), source).toEqual([]);
});

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

function existsInPackage(path: string): boolean {
  return generated.test(path) || existsSync(resolve(root, path));
}

// Moving a file leaves string paths behind. Imports fail loudly, but a bundle entry only fails
// when a browser suite runs, so every literal entry handed to a bundler must exist. Fixture
// paths that tests create in scratch directories are not bundle entries and are not checked.
// These tests write their own entry file into a scratch directory before bundling it.
const writesOwnEntry = new Set(["tests/storage-navigation-diagnostics.test.ts"]);
const bundleEntry = /(?:\bbrowserBundle\(|\bentrypoints:\s*\[|\bnew\s+Worker\()\s*([^\n;]{0,240})/g;
function staleBundleEntries(file: string, source: string): string[] {
  const missing: string[] = [];
  for (const entry of source.matchAll(bundleEntry))
    missing.push(...referencedPaths(file, entry[1] as string, existsInPackage).filter(Boolean));
  return missing;
}
test("literal bundle entries in package source point at files that exist", () => {
  const listing = Bun.spawnSync(["git", "ls-files", "-z", "--", "."], { cwd: root });
  const stale: string[] = [];
  for (const file of listing.stdout.toString().split("\0")) {
    if (
      !file.endsWith(".ts") ||
      file.endsWith(".d.ts") ||
      file === "tests/published-closure.test.ts"
    )
      continue;
    if (writesOwnEntry.has(file) || !existsSync(resolve(root, file))) continue;
    for (const path of staleBundleEntries(file, readFileSync(resolve(root, file), "utf8")))
      stale.push(`${file} -> ${path}`);
  }
  expect(stale).toEqual([]);

  const planted = 'await browserBundle(join(import.meta.dir, "storage-cleanup.ts"))';
  const [entry] = Array.from(planted.matchAll(bundleEntry));
  expect(
    referencedPaths(
      "tests/page-runner/browser-controls-suite.ts",
      entry?.[1] ?? "",
      existsInPackage,
    ),
  ).toEqual(["tests/page-runner/storage-cleanup.ts"]);
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
