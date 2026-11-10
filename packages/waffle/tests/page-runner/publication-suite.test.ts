import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkPublicationLabels,
  publicationLabels,
  workspaceLabels,
  publicationId,
} from "../publication-command.js";
import { publicationAdapter } from "./publication-suite.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const originalHashes = {
  "publication-browser.ts": "c60aefc6a26039f0fbd341b7ee4ef7ba5d2c766abb27f1a78a02f7fa2eca1ea5",
  "workspace-browser.ts": "17204218d2e58ff679edfab982741501e7322195ff947e31ec430ef0e2d82392",
  "fixtures/publication-guest.ts":
    "d2807693b52691ef1b8e5a6ef309db2dd59d9ee3305d963f1cfcff77095e6505",
  "workspace-vfs-read-browser.ts":
    "43d27744b1824a829b865f6c3403e09f234a9699da7a140428436a0ed380441c",
  "fixtures/publication-channel-observer.ts":
    "d30e355a0c6b733dda387a24bd42e522a09d0802df1615dcffea78726246e911",
  "publication-cross-tab-browser-runner.ts":
    "619b9f91455438ce46fe73573ad879ecafb106cbd369358615cf456f6dd239f7",
  "recovery-r42-browser-runner.ts":
    "fcf07ba902e231c5c158ac6f576f31e7e41c33fea1875cce452cdb43c836c791",
};
test("original fixture bodies, channel observer, and follow-on command files remain byte-identical", async () => {
  for (const [path, expected] of Object.entries(originalHashes))
    expect(hash(await readFile(join(import.meta.dir, "..", path), "utf8"))).toBe(expected);
});

test("ordinary desktop dispatch is the exact extracted original body", async () => {
  const text = await readFile(join(import.meta.dir, "../publication-browser-runner.ts"), "utf8");
  const body = text.slice(text.indexOf("const lifecycle ="), text.lastIndexOf("\n}"));
  const normalized = new Bun.Transpiler({ loader: "ts", minifyWhitespace: true }).transformSync(
    body,
  );
  expect(hash(normalized)).toBe("0dcf9d714885a15a3875a810e1b757e8de019e2b0686845bfb6194371dd7e961");
});

test("both whole-command inventories and ordered results reject omissions, reorderings and extra labels", async () => {
  const ordinary = await readFile(join(import.meta.dir, "../publication-browser.ts"), "utf8");
  const cases = ordinary.slice(
    ordinary.indexOf("  const cases:"),
    ordinary.indexOf("  const passed:"),
  );
  expect(
    Array.from(cases.matchAll(/\[\s*"([^"]+)",\s*\w+\s*,?\s*\]/g), (match) => match[1]),
  ).toEqual(publicationLabels);
  expect(publicationLabels).toHaveLength(15);
  const workspace = await readFile(join(import.meta.dir, "../workspace-browser.ts"), "utf8");
  const returned = workspace.slice(workspace.lastIndexOf("  return ["));
  expect(Array.from(returned.matchAll(/"([^"\n]+)"/g), (match) => match[1])).toEqual(
    workspaceLabels,
  );
  expect(workspaceLabels).toHaveLength(4);
  for (const mode of ["ordinary", "workspace"] as const) {
    const labels = mode === "ordinary" ? publicationLabels : workspaceLabels;
    const adapter = publicationAdapter(mode);
    expect(adapter.inventory().map((item) => item.id)).toEqual([publicationId(mode)]);
    expect(adapter.budgets(1)).toEqual({
      hello: 20000,
      heartbeat: 10000,
      case: 180000,
      group: 180000,
      run: 180000,
    });
    checkPublicationLabels(mode, labels);
    for (const invalid of [labels.slice(1), labels.toReversed(), labels.concat(["invented"]), null])
      expect(() => checkPublicationLabels(mode, invalid)).toThrow("publication controls");
  }
  expect(ordinary).toContain("equal(rejected, true)");
  expect(workspace).toContain("await deleteDatabase(name)");
});

test("the source-controlled bootstrap is before fixture imports on coordinator and peer pages", async () => {
  const page = await readFile(join(import.meta.dir, "publication-page.ts"), "utf8");
  const bootstrap = await readFile(join(import.meta.dir, "publication-bootstrap.ts"), "utf8");
  expect(page.indexOf("installPublicationBootstrap();")).toBeLessThan(
    page.indexOf("await import(path)"),
  );
  expect(bootstrap.indexOf("installWorkspaceChannelObserver();")).toBeLessThan(
    bootstrap.indexOf('Reflect.set(globalThis, "__publicationWaitForClose"'),
  );
  expect(page).toContain("peer: async () => {}");
  expect(bootstrap).toContain('fetch("/_waffle_worker_close"');
  expect(bootstrap).not.toContain("script(");
});
