import type { Page } from "playwright";

export async function stopShell(page: Page): Promise<void> {
  await page.click(".xterm");
  await page.keyboard.press("Control+c");
  await page.waitForFunction("globalThis.playground.shell.running === false");
}
