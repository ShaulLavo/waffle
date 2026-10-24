import { expect, test } from "bun:test";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";
import { recoverIndex } from "../fs/indexeddb.js";
import { publicationAdapter } from "./indexeddb-publication-browser.js";
import type { PersistedIndex } from "../fs/storage.js";

async function nativeControls(): Promise<void> {
  const lifecycle = new BrowserRunnerLifecycle(180000);
  try {
    await lifecycle.init();
    const origin = lifecycle.serve(
      {
        "/": "<!doctype html><title>Selected publication adapter</title>",
        "/tests.js": await browserBundle("tests/indexeddb-publication-browser.ts"),
      },
      0,
    );
    const names = process.argv.slice(2).filter((value) => value !== "--native");
    for (const name of names.length ? names : ["chromium"]) {
      if (name !== "chromium" && name !== "firefox" && name !== "webkit")
        throw new Error(`Unknown native engine: ${name}`);
      const browser = await lifecycle.launch(name);
      const page = await browser.newPage();
      page.on("console", (message) => console.log(message.text()));
      await page.goto(origin);
      const passed = await page.evaluate(async (filter) => {
        const path = "/tests.js";
        const suite: typeof import("./indexeddb-publication-browser.js") = await import(path);
        return suite.publicationAdapter.run(filter);
      }, process.env.PUBLICATION_ADAPTER_FILTER);
      console.log(JSON.stringify({ engine: name, version: browser.version(), passed }));
      await lifecycle.closeBrowser(browser);
    }
  } finally {
    await lifecycle.close();
  }
}
function registerRecoveryTests(): void {
  test("recovery carries the publication of the selected base and metadata journal", () => {
    const base: PersistedIndex = {
      version: 1,
      generation: 1,
      root: 1,
      nodes: publicationAdapter.batch(1).upserts,
      publication: publicationAdapter.fixture(),
    };
    const keys = new Set(["pub:1"]),
      next = publicationAdapter.fixture();
    expect(recoverIndex([base], new Map(), keys)?.publication).toEqual(base.publication);
    const entry = {
      version: 1 as const,
      previous: 1,
      generation: 2,
      root: 1,
      upserts: [],
      removes: [],
      publication: next,
    };
    const recovered = recoverIndex([base], new Map([[2, entry]]), keys);
    expect(recovered?.generation).toBe(2);
    expect(recovered?.publication).toEqual(next);
    expect(recovered?.publication?.contentVersions).toEqual([{ ino: 2, version: 1 }]);
    expect(recovered?.publication?.sessionSerial).toBe(65537);
  });
  test("an untracked journal clears publication without changing immutable payload selection", () => {
    const base: PersistedIndex = {
      version: 1,
      generation: 1,
      root: 1,
      nodes: publicationAdapter.batch(1).upserts,
      publication: publicationAdapter.fixture(),
    };
    const entry = {
      version: 1 as const,
      previous: 1,
      generation: 2,
      root: 1,
      upserts: [],
      removes: [],
    };
    const recovered = recoverIndex([base], new Map([[2, entry]]), new Set(["pub:1"]));
    expect(recovered?.generation).toBe(2);
    expect(recovered?.publication).toBeUndefined();
    expect(recovered?.nodes).toEqual(base.nodes);
  });
}
if (import.meta.main && process.argv.includes("--native")) await nativeControls();
else registerRecoveryTests();
