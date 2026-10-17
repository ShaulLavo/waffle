import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { ContentModules } from "../src/content-modules";

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
const contentUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

test("acyclic modules import without a named store and keep shared dependency identity", async () => {
  let builds = 0;
  const modules = new ContentModules({
    named: { url() { throw new Error("module requires HTTP"); }, put() { throw new Error("module requires Cache Storage"); } },
    paths: new Map(), storing: [], contentUrl,
    source(key) {
      if (key === "dep") { builds++; return "export const value = {};"; }
      const first = JSON.stringify(modules.ensure("dep"));
      const second = JSON.stringify(modules.ensure("dep"));
      return `import {value as first} from ${first}; import {value as second} from ${second}; export default first === second;`;
    },
  });
  expect((await import(modules.ensure("main"))).default).toBe(true);
  expect(builds).toBe(1);
});

for (const retry of ["a", "b"]) test(`failed cycles retry through ${retry === "a" ? "the root" : "a cached child"}`, async () => {
  const scratch = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const root = mkdtempSync(join(scratch, "bun-wasm-content-modules-retry-"));
  owned.push(root);
  const writes: Promise<unknown>[] = [];
  const paths = new Map<string, string>();
  let missing = false;
  let modules: ContentModules;
  const named = {
    url(key: string) { return pathToFileURL(join(root, `${key}.mjs`)).href; },
    put(url: string, source: string) { return writeFile(new URL(url), source); },
  };
  modules = new ContentModules({
    named, paths, storing: writes, contentUrl,
    source(key) {
      if (key === "a") {
        const dependency = modules.ensure("b");
        if (!missing) throw Object.assign(new Error("Cannot find module ./missing.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
        modules.ensure("missing");
        return `import {b} from ${JSON.stringify(dependency)}; export function a() { return 'a'; } export const result = b();`;
      }
      if (key === "b") {
        const rootUrl = modules.ensure("a");
        return `import {a} from ${JSON.stringify(rootUrl)}; export function b() { return a() + "b"; }`;
      }
      return "export function a() { return 'a'; }";
    },
  });
  expect(() => modules.ensure("a")).toThrow(expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }));
  missing = true;
  const entry = modules.ensure(retry);
  await Promise.all(writes.splice(0));
  const value = retry === "a" ? ".result" : ".b()";
  const imported = spawnSync("node", ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(entry)}))${value})`], { encoding: "utf8" });
  expect(imported.stderr).toBe("");
  expect(imported.status).toBe(0);
  expect(imported.stdout.trim()).toBe("ab");
  expect(paths.get(named.url("a"))).toBe("a");
});

test("a failed enclosing graph preserves a reentrant import's identity", async () => {
  let generated = 0;
  let independent: Promise<{ value: object }> | undefined;
  const modules = new ContentModules({
    paths: new Map(), storing: [],
    contentUrl: source => contentUrl(`${source}\n// URL ${generated++}`),
    source(key) {
      if (key === "main") {
        independent = import(modules.ensure("dep"));
        throw new Error("missing sibling");
      }
      return "export const value = {};";
    },
  });
  expect(() => modules.ensure("main")).toThrow("missing sibling");
  expect((await import(modules.ensure("dep"))).value).toBe((await independent)?.value);
  expect(generated).toBe(1);
});

test("a handled failing reentrant import does not become a static dependency", async () => {
  let failures = 0;
  const modules = new ContentModules({
    named: { url: key => `memory:${key}`, put() {} },
    paths: new Map(), storing: [], contentUrl,
    source(key) {
      if (key === "main") {
        try { modules.ensure("bad"); } catch { /* The CommonJS wrapper handled its dynamic import. */ }
        return "export const value = 1;";
      }
      if (key === "bad") {
        failures++;
        modules.ensure("child");
        throw new Error("missing sibling");
      }
      return `import ${JSON.stringify(modules.ensure("bad"))};`;
    },
  });
  const first = modules.ensure("main");
  expect(modules.ensure("main")).toBe(first);
  expect((await import(first)).value).toBe(1);
  expect(failures).toBe(1);
});

test("cyclic modules retain native hoisting through a named back edge", async () => {
  const scratch = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const root = mkdtempSync(join(scratch, "bun-wasm-content-modules-"));
  owned.push(root);
  const writes: Promise<unknown>[] = [];
  const named: string[] = [];
  const paths = new Map<string, string>();
  const modules = new ContentModules({
    named: {
      url(key) { named.push(key); return pathToFileURL(`${root}/${key}.mjs`).href; },
      put(url, source) { return writeFile(new URL(url), source); },
    },
    paths, storing: writes, contentUrl,
    source(key) {
      if (key === "a") return `import {b} from ${JSON.stringify(modules.ensure("b"))}; export function a() { return 'a'; } export const result = b();`;
      return `import {a} from ${JSON.stringify(modules.ensure("a"))}; export function b() { return a() + 'b'; }`;
    },
  });
  const entry = modules.ensure("a");
  await Promise.all(writes);
  const imported = spawnSync("node", ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(entry)})).result)`], { encoding: "utf8" });
  expect(imported.stderr).toBe("");
  expect(imported.status).toBe(0);
  expect(imported.stdout.trim()).toBe("ab");
  expect(named).toEqual(["a"]);
  expect(paths.get(entry)).toBe("a");
});

test("cycles without a named store still report ERR_CIRCULAR_IMPORT", () => {
  const modules = new ContentModules({ paths: new Map(), storing: [], contentUrl, source: key => modules.ensure(key) });
  expect(() => modules.ensure("a")).toThrow(expect.objectContaining({ code: "ERR_CIRCULAR_IMPORT" }));
});
