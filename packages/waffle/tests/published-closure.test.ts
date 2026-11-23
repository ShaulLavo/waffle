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

// A module specifier may name the .ts source with a .js extension, because the bundler and the
// prepared dist output resolve it. A path read as data names one exact file.
function candidates(
  from: string,
  specifier: string,
  kind: "module" | "asset",
  entry: boolean,
): string[] {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (kind === "asset" && !entry) return [base];
  return [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`];
}

const modulePatterns = [
  /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s+["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\.meta\.resolve\(\s*["'](\.{1,2}\/[^"']+)["']/g,
];
const assetPatterns = [
  // A bare "name.wasm" is relative to the importing file, like "./name.wasm".
  /\bnew\s+URL\(\s*["']((?![a-z][a-z0-9+.-]*:|\/)[^"']+)["']\s*,\s*import\.meta\.url/g,
  /\bimport\.meta\.(?:dir|dirname)\s*\+\s*["']\/([^"']+)["']/g,
  /\$\{import\.meta\.(?:dir|dirname)\}\/([^`"'$]+)/g,
];
const directoryPattern =
  /\b(?:join|resolve)\(\s*import\.meta\.(?:dir|dirname)\s*,((?:\s*["'][^"']*["']\s*,?)+)\s*\)/g;

function referencedPaths(
  file: string,
  rawSource: string,
  available: (path: string) => boolean = isPublished,
  entry = false,
): string[] {
  const source = rawSource
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join("\n");
  const found: { specifier: string; kind: "module" | "asset" }[] = [];
  for (const pattern of modulePatterns)
    for (const match of source.matchAll(pattern))
      found.push({ specifier: match[1] as string, kind: "module" });
  for (const pattern of assetPatterns)
    for (const match of source.matchAll(pattern))
      found.push({ specifier: match[1] as string, kind: "asset" });
  for (const match of source.matchAll(directoryPattern)) {
    const parts = Array.from((match[1] as string).matchAll(/["']([^"']*)["']/g), (part) => part[1]);
    found.push({ specifier: posix.join(".", ...(parts as string[])), kind: "asset" });
  }
  return found.map(({ specifier, kind }) => {
    const options = candidates(file, specifier, kind, entry);
    if (options[0] === ".") return "";
    return options.some((option) => available(option)) ? "" : options[0]!;
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
  expect(published.size).toBeGreaterThan(100);
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
// when a browser suite runs, so every literal entry handed to a bundler or Worker must exist.
// The bundler resolves a ".js" entry to its ".ts" source, so entries use module resolution.
// Fixture paths that tests create in scratch directories are not entries and are not checked.
// These tests write their own entry file into a scratch directory before bundling it.
const writesOwnEntry = new Set(["tests/storage-navigation-diagnostics.test.ts"]);
const entryStart = /(?:\bbrowserBundle\(|\bentrypoints:\s*\[|\bnew\s+Worker\()/g;

/** The text of a call's arguments, up to its matching close, across lines and nested calls. */
function callArguments(source: string, from: number): string {
  let depth = 1;
  let quote = "";
  for (let at = from; at < source.length; at++) {
    const char = source[at] as string;
    if (quote) {
      if (char === "\\") at++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if ((char === ")" || char === "]") && --depth === 0) return source.slice(from, at);
  }
  return source.slice(from);
}

function staleBundleEntries(file: string, source: string): string[] {
  const missing: string[] = [];
  for (const start of source.matchAll(entryStart)) {
    const text = callArguments(source, (start.index ?? 0) + start[0].length);
    missing.push(...referencedPaths(file, text, existsInPackage, true).filter(Boolean));
  }
  return missing;
}

type Run = () => { exitCode: number; stdout: { toString(): string } };
const listTracked: Run = () => Bun.spawnSync(["git", "ls-files", "-z", "--", "."], { cwd: root });

/** Fails closed: a failed or empty listing would otherwise let every stale path pass. */
function trackedTypeScript(run: Run): string[] {
  const listing = run();
  if (listing.exitCode !== 0) throw new Error("git ls-files failed");
  const files = listing.stdout.toString().split("\0").filter(Boolean);
  if (!files.includes("package.json")) throw new Error("git ls-files returned no package files");
  return files.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
}

test("the bundle entry check parses wrapped calls and fails closed", () => {
  const wrapped = `await browserBundle(
    join(
      import.meta.dir,
      "storage-cleanup.ts",
    ),
  );`;
  expect(staleBundleEntries("tests/page-runner/browser-controls-suite.ts", wrapped)).toEqual([
    "tests/page-runner/storage-cleanup.ts",
  ]);
  const stale = 'new Worker(new URL("./missing-worker.js", import.meta.url), { type: "module" })';
  expect(staleBundleEntries("tests/example.ts", stale)).toEqual(["tests/missing-worker.js"]);
  const present = 'browserBundle(resolve(import.meta.dir, "../testing/storage-browser.ts"))';
  expect(staleBundleEntries("tests/example.ts", present)).toEqual([]);
  expect(() => trackedTypeScript(() => ({ exitCode: 128, stdout: "" }))).toThrow("failed");
  expect(() => trackedTypeScript(() => ({ exitCode: 0, stdout: "" }))).toThrow("no package files");
});

test("literal bundle entries in package source point at files that exist", () => {
  const stale: string[] = [];
  for (const file of trackedTypeScript(listTracked)) {
    if (file === "tests/published-closure.test.ts" || writesOwnEntry.has(file)) continue;
    for (const path of staleBundleEntries(file, readFileSync(resolve(root, file), "utf8")))
      stale.push(`${file} -> ${path}`);
  }
  expect(stale).toEqual([]);
});

test("asset reads need the exact published file, not its .ts source", () => {
  const read = (source: string) => referencedPaths("browser/example.ts", source).filter(Boolean);
  expect(read('new URL("worker.js", import.meta.url)')).toEqual(["browser/worker.js"]);
  expect(read('new URL("worker.ts", import.meta.url)')).toEqual([]);
  expect(read('import("./worker.js")')).toEqual([]);
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
