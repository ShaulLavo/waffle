import { test, expect } from "./helpers/browser-test";
import { ready } from "./helpers/readiness.ts";
import { command, output, open, compareCases } from "./helpers/text-program-browser.ts";
import { trCases } from "./helpers/tr-cases.ts";

const cases = trCases();
test("tr loads on first use and matches all frozen GNU observations", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const workers = await open(page);
  const trRequests = () => requests.filter((path) => /\/tr(?:-[^/]+)?\.wasm$/.test(path));
  expect(trRequests()).toHaveLength(0);
  await compareCases(page, cases, workers);
  expect(trRequests()).toHaveLength(1);
});

test("tr cancellation restores workers and permits another invocation", async ({ page }) => {
  const workers = await open(page);
  await command(page, "while printf x; do :; done | tr a-z A-Z > /tmp/tr-interrupted");
  await expect.poll(() => page.workers().length).toBe(workers + 1);
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, "echo TR_CANCEL:$?; printf b | tr a-z A-Z; echo TR_RECOVERED");
  await output(page, "TR_CANCEL:130");
  await output(page, "BTR_RECOVERED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(workers);
});
