import { expect, test } from "bun:test";
import { snapshotPublicationCheckpoint } from "../fs/publication.js";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle.js";
import { checkpointDecodeControl } from "./indexeddb-checkpoint-decode-browser.js";

function validationTests(): void {
  test("small selected checkpoint owns a valid bounded change and reserved frontier", () => {
    const fixture = checkpointDecodeControl.fixture();
    const copied = snapshotPublicationCheckpoint(fixture);
    expect(copied).toEqual(fixture);
    expect(copied.changes[0]).not.toBe(fixture.changes[0]);
    expect(copied.sessionSerial).toBe(65536);
    expect(copied.contentVersions).toEqual([{ ino: 2, version: 1 }]);
    expect(copied.changes).toHaveLength(1);
    expect(copied.changes[0]!.length).toBeLessThanOrEqual(1024);
  });
  test("small selected checkpoint rejects more than one change", () => {
    const fixture = checkpointDecodeControl.fixture();
    expect(() =>
      snapshotPublicationCheckpoint({
        ...fixture,
        changes: fixture.changes.concat(fixture.changes),
      }),
    ).toThrow();
  });
  test("small selected checkpoint rejects a change above its effect byte limit", () => {
    const fixture = checkpointDecodeControl.fixture();
    expect(() =>
      snapshotPublicationCheckpoint({ ...fixture, changes: [new Uint8Array(1025)] }),
    ).toThrow();
  });
}
async function nativeControl(): Promise<void> {
  const lifecycle = new BrowserRunnerLifecycle(180000);
  try {
    await lifecycle.init();
    const origin = lifecycle.serve(
      {
        "/": "<!doctype html><title>Checkpoint decoder bounds</title>",
        "/tests.js": await browserBundle("tests/indexeddb-checkpoint-decode-browser.ts"),
      },
      0,
    );
    const browser = await lifecycle.launch("chromium");
    const page = await browser.newPage();
    page.on("console", (message) => console.log(message.text()));
    await page.goto(origin);
    await page.evaluate(async () => {
      const path = "/tests.js";
      const controls: typeof import("./indexeddb-checkpoint-decode-browser.js") = await import(
        path
      );
      await controls.checkpointDecodeControl.run();
    });
    console.log(
      JSON.stringify({
        engine: "chromium",
        version: browser.version(),
        passed: "checkpoint pre-copy bounds",
      }),
    );
    await lifecycle.closeBrowser(browser);
  } finally {
    await lifecycle.close();
  }
}
if (import.meta.main && process.argv.includes("--native")) await nativeControl();
else validationTests();
