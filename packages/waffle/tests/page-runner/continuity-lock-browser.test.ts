import { expect, test } from "bun:test";
import { join } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "../browser-runner-lifecycle.js";

test.skipIf(process.env.CONTINUITY_LOCK_CONTROLS !== "1")(
  "page continuity observer preserves original guard/helper outcomes in Chromium",
  async () => {
    const lifecycle = new BrowserRunnerLifecycle(90_000);
    try {
      await lifecycle.init(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp");
      const script = await browserBundle(join(import.meta.dir, "continuity-lock-control-page.ts"));
      const origin = lifecycle.serve({
        "/": new Blob(['<script type="module" src="/control.js"></script>'], { type: "text/html" }),
        "/control.js": script,
      });
      const browser = await lifecycle.launch("chromium");
      const page = await browser.newPage();
      await page.goto(origin);
      await page.waitForFunction("typeof window.__runContinuityControls === 'function'");
      const labels: unknown = await page.evaluate("window.__runContinuityControls()");
      expect(Array.isArray(labels) && labels.length).toBe(12);
      console.log(JSON.stringify({ continuityControls: labels }));
    } finally {
      await lifecycle.close();
    }
  },
  100_000,
);
