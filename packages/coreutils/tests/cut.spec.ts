import { test, expect } from "./helpers/browser-test";
import { ready } from "./helpers/readiness.ts";
import { cutTrRecording } from "./helpers/cut-tr-recording.ts";

import { command, output, open, compareCases } from "./helpers/text-program-browser.ts";

const { cases } = cutTrRecording();

const name = "cut";
test(`${name} stays separately lazy and matches GNU in the browser`, async ({ page }) => {
  test.setTimeout(180000);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const workers = await open(page);
  const fetched = (program: string) =>
    requests.filter((path) => /\/(cut|tr)(?:-[^/]+)?\.wasm$/.exec(path)?.[1] === program);
  expect(fetched("cut")).toHaveLength(0);
  expect(fetched("tr")).toHaveLength(0);
  await compareCases(
    page,
    cases.filter(({ name: label }) => label.startsWith(`${name} `)),
    workers,
  );
  expect(fetched(name)).toHaveLength(1);
  expect(fetched("tr")).toHaveLength(0);
});

test(`${name} Ctrl+C returns status 130 and keeps the shell usable`, async ({ page }) => {
  const workers = await open(page);
  const commandLine = "cut -b1-";
  await command(
    page,
    `printf 'INTERRUPT_READY\\n'; while printf x; do :; done | ${commandLine} > /tmp/interrupted`,
  );
  await output(page, "INTERRUPT_READY");
  await expect.poll(() => page.workers().length).toBe(workers + 1);
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, `echo TEXT_INTERRUPT:$?; printf 'a:b\\n' | cut -d: -f2; echo TEXT_RECOVERED`);
  await output(page, "TEXT_INTERRUPT:130");
  await output(page, "b");
  await output(page, "TEXT_RECOVERED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(workers);
});
