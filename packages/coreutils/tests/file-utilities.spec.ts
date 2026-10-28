import { test, expect } from "./helpers/browser-test";
import { fileUtilityCases, initialTree } from "./helpers/file-utility-cases.ts";
import { fileUtilityObservation } from "../scripts/file-utilities-observations.ts";

for (const example of fileUtilityCases) {
  test(`ordinary file utility matches GNU: ${example.name}`, async ({ page }) => {
    const expected = fileUtilityObservation(example.script);
    await page.goto("/file-utilities-tests.html");
    await page.waitForFunction(() => Boolean(window.fileUtilities));
    expect(
      await page.evaluate((script) => window.fileUtilities.check(script), example.script),
    ).toEqual(expected);
    await expect.poll(() => page.workers().length).toBe(0);
  });
}

test("public file utility entries load independently on first use and release only their registrations", async ({
  page,
}) => {
  await page.goto("/file-utilities-tests.html");
  await page.waitForFunction(() => Boolean(window.fileUtilities));
  expect(await page.evaluate(() => window.fileUtilities.lifecycle())).toEqual({
    before: [],
    afterTouch: ["touch"],
    afterAll: ["touch", "cp", "mv", "rm"],
    missing: 127,
    ownerAlive: "alive",
    removed: [true, true, true, true],
  });
  await expect.poll(() => page.workers().length).toBe(0);
});

test("ordinary interactive copy cancels and the caller runtime remains usable", async ({
  page,
}) => {
  await page.goto("/file-utilities-tests.html");
  await page.waitForFunction(() => Boolean(window.fileUtilities));
  expect(await page.evaluate(() => window.fileUtilities.cancel())).toEqual({
    status: 130,
    after: 0,
    created: true,
  });
  await expect.poll(() => page.workers().length).toBe(0);
});

test("terminal mv records the current synthetic-permission limitation", async ({ page }) => {
  await page.goto("/file-utilities-tests.html");
  await page.waitForFunction(() => Boolean(window.fileUtilities));
  expect(await page.evaluate(() => window.fileUtilities.metadataGap())).toEqual({
    actual: { status: 1, stdout: [], stderr: true, tree: initialTree },
    diagnostic: "mv: overwrite 'existing'? ",
  });
  await expect.poll(() => page.workers().length).toBe(0);
});
