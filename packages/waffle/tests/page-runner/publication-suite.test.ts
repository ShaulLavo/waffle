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
  // Moved to setTimes and nanosecond records with file times (plans/file-times.md).
  "publication-browser.ts": "10f86e3f045867bcc1f45becfd223c62747f533a30dae357174bfcbe7501855d",
  "workspace-browser.ts": "a768192fb6bc91f53337ad5ea82b177acfca6db598db1d5df0b52d237d31e878",
  // File-only fixture supplies the required bound logical pair; its publication body is unchanged.
  "fixtures/publication-guest.ts":
    "78619558fa3965ebad62b27063be171cb560a37e6cee4446e7f01ea2e98bd06f",
  "workspace-vfs-read-browser.ts":
    "6724f44c5d28721e1abc537770b22080f3dff21dd8a10710e9748db4153e1318",
  "fixtures/publication-channel-observer.ts":
    "d30e355a0c6b733dda387a24bd42e522a09d0802df1615dcffea78726246e911",
  "recovery-r42-browser-runner.ts":
    "fcf07ba902e231c5c158ac6f576f31e7e41c33fea1875cce452cdb43c836c791",
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
