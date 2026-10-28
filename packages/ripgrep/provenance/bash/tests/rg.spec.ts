import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness";
import { rgCases, rgUnsupported, shellQuote } from "./helpers/rg-fixtures";

const directory = "/home/guest/rg-fixture";

async function command(page: Page, text: string) {
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}

async function readFile(page: Page, path: string) {
  return page.evaluate((name) => window.rgTest?.readFile(name), `/tmp/rg-${path}`);
}

async function finished(page: Page, marker: string) {
  await expect.poll(() => readFile(page, "status")).toBe(marker);
  await ready(page);
}

async function open(page: Page) {
  await page.goto("/?test=1&rg=1&renderer=canvas");
  await startupReady(page);
  await page.locator("textarea").focus();
  await command(page, "cd rg-fixture; printf READY > /tmp/rg-status");
  await finished(page, "READY");
}

test("upstream ripgrep loads on first use and preserves paths, ignores, patterns, output and status", async ({
  page,
}) => {
  let fetches = 0;
  page.on("request", (request) => {
    if (/rg(?:-[^/]+)?\.wasm$/.test(new URL(request.url()).pathname)) fetches++;
  });
  await open(page);
  expect(fetches).toBe(0);
  const workers = page.workers().length;
  let index = 0;
  for (const fixture of rgCases) {
    const input = fixture.stdin
      ? `printf %b ${shellQuote(fixture.stdin.replaceAll("\\", "\\\\").replaceAll("\n", "\\n"))} | `
      : "";
    const marker = `${index++}:`;
    await command(
      page,
      `${input}rg ${fixture.args.map(shellQuote).join(" ")} > /tmp/rg-result 2> /tmp/rg-errors; printf '${marker}%s' "$?" > /tmp/rg-status`,
    );
    await finished(page, `${marker}${fixture.status}`);
    expect(await readFile(page, "result"), fixture.name).toBe(fixture.stdout);
    if (fixture.error)
      expect(await readFile(page, "errors"), fixture.name).toContain(fixture.error);
    else expect(await readFile(page, "errors"), fixture.name).toBe("");
  }
  expect(fetches).toBe(1);
  await expect.poll(() => page.workers().length).toBe(workers);
});

test("ripgrep fails clearly for unavailable WASI options", async ({ page }) => {
  await open(page);
  let index = 0;
  for (const fixture of rgUnsupported) {
    const marker = `${index++}:`;
    await command(
      page,
      `rg ${fixture.args.map(shellQuote).join(" ")} needle . > /tmp/rg-result 2> /tmp/rg-errors; printf '${marker}%s' "$?" > /tmp/rg-status`,
    );
    await finished(page, `${marker}2`);
    expect(await readFile(page, "result")).toBe("");
    expect(await readFile(page, "errors")).toContain(fixture.error);
  }
});

test("ripgrep handles a closed downstream pipe and remains usable after Ctrl+C", async ({
  page,
}) => {
  await open(page);
  const workers = page.workers().length;
  await page.evaluate(
    (path) => window.rgTest?.writeFile(path, "needle\n".repeat(200000)),
    `${directory}/large`,
  );
  await command(
    page,
    'set -o pipefail; rg --line-buffered needle large | { read -r first; printf \'%s\' "$first" > /tmp/rg-first; }; printf \'PIPE:%s:%s\' "$?" "${PIPESTATUS[0]}" > /tmp/rg-status',
  );
  await finished(page, "PIPE:1:1");
  expect(await readFile(page, "first")).toBe("needle");
  await expect.poll(() => page.workers().length).toBe(workers);
  await command(page, "rg '^never$' -");
  await expect.poll(() => page.workers().length).toBe(workers + 1);
  await page.keyboard.press("Control+C");
  await ready(page);
  await command(page, "printf 'INTERRUPT:%s' \"$?\" > /tmp/rg-status");
  await finished(page, "INTERRUPT:130");
  await expect.poll(() => page.workers().length).toBe(workers);
  await command(
    page,
    "rg -c needle src/alpha.txt > /tmp/rg-result; printf 'RECOVER:%s' \"$?\" > /tmp/rg-status",
  );
  await finished(page, "RECOVER:0");
  expect(await readFile(page, "result")).toBe("2\n");
});
