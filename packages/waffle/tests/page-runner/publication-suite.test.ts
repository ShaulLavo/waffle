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
  // Updated for setTimes/nanoseconds and single-delivery write failures (drain no longer re-throws).
  "publication-browser.ts": "ab0c399cbb7184275b0716f5be2a04ab79bdb1186aaa11b32a295e13a06d6371",
  "workspace-browser.ts": "efd231caac240a656454f8bce4c16c466bd12f9f211b797bba9d308229c27e18",
  // File-only fixture supplies the required bound logical pair; its publication body is unchanged.
  "fixtures/publication-guest.ts":
    "78619558fa3965ebad62b27063be171cb560a37e6cee4446e7f01ea2e98bd06f",
  "workspace-vfs-read-browser.ts":
    "b04780cd00034d31acc1cced82f420be0ba19797dc2dcc9f5c1744aea18f0537",
  "fixtures/publication-channel-observer.ts":
    "d30e355a0c6b733dda387a24bd42e522a09d0802df1615dcffea78726246e911",
  "recovery-r42-browser-runner.ts":
    "1ff4879b7e52a2014f56d258c26127d8c422d00d3f564c9b670a4e124443857e",
};
test("original fixture bodies, channel observer, and follow-on command files remain byte-identical", async () => {
  for (const [path, expected] of Object.entries(originalHashes))
    expect(hash(await readFile(join(import.meta.dir, "..", path), "utf8"))).toBe(expected);
});

test("desktop dispatch preserves the original body outside browser setup and cleanup", async () => {
  const text = await readFile(join(import.meta.dir, "../publication-browser-runner.ts"), "utf8");
  const body = text.slice(text.indexOf("const lifecycle ="), text.lastIndexOf("\n}"));
  const setup = body.indexOf("    const previousTmp =");
  const dispatch = body.indexOf('      page.on("console"');
  const cleanup = body.indexOf("    } finally {", dispatch);
  const root = body.indexOf("\n  try {\n    await lifecycle.init();", cleanup);
  // Only browser context policy differs from the original extracted dispatcher.
  const unchanged =
    body.slice(0, setup) +
    "    try {\n" +
    body.slice(dispatch, cleanup) +
    "    } finally {}\n  }" +
    body.slice(root);
  const normalized = new Bun.Transpiler({ loader: "ts", minifyWhitespace: true }).transformSync(
    unchanged,
  );
  expect(hash(normalized)).toBe("3ba59108f7de674fcdefa7e7cb4ec28bdd27966b6853af448a61032e3a77319a");
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
