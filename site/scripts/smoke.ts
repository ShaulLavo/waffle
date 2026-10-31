// Browser smoke check for the built landing page. For each engine and viewport it checks that
// the page throws no errors, the 3D scene paints, the scroll story reaches its last step, no
// text spills past the right edge, and every link has a real target.
//
//   SITE_URL=http://127.0.0.1:4323/ ENGINES=chromium,firefox,webkit bun scripts/smoke.ts
import assert from "node:assert/strict";
import { chromium, firefox, webkit, type BrowserType, type Page } from "playwright";

const url = process.env.SITE_URL ?? "http://127.0.0.1:4323/";
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
const selected = (process.env.ENGINES ?? "chromium").split(",").filter(Boolean);
const viewports = [
  { name: "phone", width: 390, height: 844, touch: true, reduce: false },
  { name: "phone, reduced motion", width: 390, height: 844, touch: true, reduce: true },
  { name: "tablet", width: 820, height: 1180, touch: true, reduce: false },
  { name: "desktop", width: 1440, height: 900, touch: false, reduce: false },
];
// Source files and the landing site link to these docs; AGENTS.md asks that they keep working.
const requiredDocs = ["docs/getting-started.md", "docs/architecture.md", "docs/host-abi.md"];

async function sceneState(page: Page): Promise<"ready" | "no-gl" | "pending"> {
  return page.evaluate(() => {
    if (document.querySelector("[data-story]")?.hasAttribute("data-no-gl")) return "no-gl";
    return document.querySelector("[data-scene]")?.hasAttribute("data-ready") ? "ready" : "pending";
  });
}

async function waitForScene(page: Page) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await sceneState(page);
    if (state !== "pending") return state;
    await page.waitForTimeout(250);
  }
  return "pending";
}

async function overflowingText(page: Page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const selector = "h1, h2, h3, p, li, a, dt, dd, span";
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => !element.closest("pre, .term, .code, .stage, [aria-hidden='true']"))
      .filter((element) => element.getBoundingClientRect().right > limit)
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}: ${element.textContent?.trim().slice(0, 40)}`,
      );
  });
}

async function brokenLinks(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => {
        if (!href || href === "#") return true;
        if (!href.startsWith("#")) return false;
        return !document.getElementById(href.slice(1));
      }),
  );
}

async function check(engine: string, viewport: (typeof viewports)[number]) {
  const browser = await engines[engine]!.launch();
  const label = `${engine} ${viewport.name}`;
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
      reducedMotion: viewport.reduce ? "reduce" : "no-preference",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(url, { waitUntil: "load" });

    const scene = await waitForScene(page);
    assert.notEqual(
      scene,
      "pending",
      `${label}: the scene neither painted nor reported missing WebGL`,
    );

    const storyEnd = await page.evaluate(() => {
      const story = document.querySelector<HTMLElement>("[data-story]");
      return story ? story.offsetTop + story.offsetHeight - window.innerHeight : 0;
    });
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), storyEnd);
    await page.waitForTimeout(2500);
    const blueprint = await page.evaluate(() =>
      Number(getComputedStyle(document.querySelector("[data-blueprint]")!).opacity),
    );
    assert.ok(
      blueprint < 0.05,
      `${label}: the story did not reach the sky (blueprint ${blueprint})`,
    );

    assert.deepEqual(await overflowingText(page), [], `${label}: text spills past the right edge`);
    assert.deepEqual(await brokenLinks(page), [], `${label}: links without a target`);
    const hrefs = await page.evaluate(() => Array.from(document.links, (link) => link.href));
    for (const doc of requiredDocs) {
      assert.ok(
        hrefs.some((href) => href.endsWith(doc)),
        `${label}: missing link to ${doc}`,
      );
    }
    // Without WebGL, three.js logs why it could not create a context; the page then shows its
    // fallback note. Those messages are expected in that case and nothing else is.
    const unexpected = errors.filter(
      (text) => !(scene === "no-gl" && text.startsWith("THREE.WebGLRenderer")),
    );
    assert.deepEqual(unexpected, [], `${label}: browser errors`);
    console.log(`${label}: ok (scene ${scene})`);
  } finally {
    await browser.close();
  }
}

const failures: string[] = [];
for (const engine of selected) {
  assert.ok(engines[engine], `Unknown engine ${engine}`);
  for (const viewport of viewports) {
    try {
      await check(engine, viewport);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
}
assert.deepEqual(failures, [], `Landing smoke check failed:\n${failures.join("\n")}`);
