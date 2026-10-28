import { test, expect, type Page } from "./helpers/browser-test";
import { startupReady, ready } from "./helpers/readiness.ts";
import { loadSortUniqObservations } from "../scripts/sort-uniq-observations.ts";

function readLines(page: Page) {
  return page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()) ?? []);
}

test("sort and uniq replay frozen GNU usage cases and load independently in the browser", async ({
  page,
}) => {
  const fetched: string[] = [];
  page.on("request", (request) => {
    const match = /\/(sort|uniq)(?:-[^/]+)?\.wasm(?:\?|$)/.exec(request.url());
    if (match) fetched.push(match[1]);
  });
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  expect(fetched).toEqual([]);
  await page.locator("textarea").focus();
  for (const [index, expected] of loadSortUniqObservations().entries()) {
    const end = `SORT_UNIQ_END_${index}:${expected.status}`;
    await page.keyboard.insertText(
      `(${expected.script}) >/tmp/sort-uniq-output 2>/tmp/sort-uniq-error; rc=$?; printf 'SORT_UNIQ_END_${index}:%s\\n' "$rc"`,
    );
    await page.keyboard.press("Enter");
    await expect.poll(() => readLines(page), { message: expected.name }).toContain(end);
    const actual = await page.evaluate(() => window.readSortUniqOutput!());
    expect(actual.stdout, expected.name).toEqual(expected.stdout);
    expect(actual.stderrPresent, expected.name).toBe(expected.stderrPresent);
    await ready(page);
    if (index === 0) expect(fetched.filter((url) => url === "uniq")).toEqual([]);
  }
  for (const name of ["sort", "uniq"]) {
    await page.keyboard.insertText(`while :; do printf x; done | ${name}`);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
    await page.keyboard.press("Control+c");
    await ready(page);
    await page.keyboard.insertText(`printf '${name}-interrupt:%s\\n' "$?"`);
    await page.keyboard.press("Enter");
    await expect.poll(() => readLines(page)).toContain(`${name}-interrupt:130`);
    await ready(page);
  }
  expect(fetched.filter((url) => url === "sort")).toHaveLength(1);
  expect(fetched.filter((url) => url === "uniq")).toHaveLength(1);
});
