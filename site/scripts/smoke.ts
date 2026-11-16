// Browser smoke check for the built site, at phone, tablet and desktop sizes in each engine.
//
//   /         no browser errors, failed requests or requests to another origin; the process-table
//             drawing has sixteen slots; the demo session advances, pauses, and stops off screen;
//             the terminal always holds eight rows; reduced motion is still; no text spills
//             sideways; links have targets; the skip link is the first tab stop and every tab stop
//             shows an unclipped focus ring.
//   /old/     the previous page: the 3D scene paints (or reports missing WebGL) and the story
//             reaches the sky.
//   missing   a URL that does not exist answers 404 with the designed page.
//
// Checks assert outcomes. The only time limits are hang caps.
//
//   SITE_URL=http://127.0.0.1:4323/ ENGINES=chromium,firefox,webkit bun scripts/smoke.ts
import assert from "node:assert/strict";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";

const url = process.env.SITE_URL ?? "http://127.0.0.1:4323/";
const origin = new URL(url).origin;
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
const selected = (process.env.ENGINES ?? "chromium").split(",").filter(Boolean);
const viewports = [
  { name: "phone", width: 390, height: 844, touch: true, reduce: false },
  { name: "phone, reduced motion", width: 390, height: 844, touch: true, reduce: true },
  { name: "tablet", width: 820, height: 1180, touch: true, reduce: false },
  { name: "desktop", width: 1440, height: 900, touch: false, reduce: false },
];
type Viewport = (typeof viewports)[number];
/** Generous cap for something that should happen within a few seconds. */
const HANG = 30_000;

interface Watch {
  errors: string[];
  foreign: string[];
  failed: string[];
}

async function open(browser: Browser, viewport: Viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    reducedMotion: viewport.reduce ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const watch: Watch = { errors: [], foreign: [], failed: [] };
  page.on("pageerror", (error) => watch.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") watch.errors.push(message.text());
  });
  page.on("request", (request) => {
    const target = request.url();
    if (!target.startsWith("data:") && new URL(target).origin !== origin)
      watch.foreign.push(target);
  });
  page.on("requestfailed", (request) =>
    watch.failed.push(`${request.url()} ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) watch.failed.push(`${response.url()} ${response.status()}`);
  });
  return { context, page, watch };
}

async function overflowingText(page: Page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const selector = "h1, h2, h3, p, li, a, dt, dd, span";
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => !element.closest("pre, .term, .code, .stage, svg, [aria-hidden='true']"))
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

async function hrefs(page: Page) {
  return page.evaluate(() => Array.from(document.links, (link) => link.href));
}

/** Rows in the terminal and whether its view is exactly eight rows tall and full. */
async function terminal(page: Page) {
  return page.evaluate(() => {
    const pre = document.getElementById("tty")!;
    const view = pre.parentElement!;
    const row = parseFloat(getComputedStyle(pre).lineHeight);
    return {
      lines: (pre.textContent ?? "").split("\n").length,
      rows: Math.round(view.clientHeight / row),
      full: pre.offsetHeight >= view.clientHeight - 1,
    };
  });
}

async function eightRows(page: Page, label: string, samples: number) {
  for (let n = 0; n < samples; n++) {
    const state = await terminal(page);
    assert.deepEqual(
      state,
      { lines: 8, rows: 8, full: true },
      `${label}: terminal is not eight full rows`,
    );
    await page.waitForTimeout(200);
  }
}

/** A snapshot of everything the session changes: the terminal, gauges and block states. */
async function sessionState(page: Page) {
  return page.evaluate(
    () =>
      (document.getElementById("tty")?.innerHTML ?? "") +
      Array.from(document.querySelectorAll(".gauges dd"), (dd) => dd.textContent).join() +
      Array.from(document.querySelectorAll("#plate .cube, #plate .tag"), (node) =>
        node.getAttribute("class"),
      ).join(),
  );
}

async function stillFor(page: Page, ms: number) {
  const before = await sessionState(page);
  await page.waitForTimeout(ms);
  return before === (await sessionState(page));
}

async function detailState(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll("#details .cube, #details .tick, #details .slot"),
      (node) => node.getAttribute("class"),
    ).join(),
  );
}

/**
 * Tabs through the page. The skip link must come first, and each stop must draw an outline that no
 * clipping ancestor cuts and no other element covers.
 */
async function focusRings(page: Page, label: string) {
  // A fresh load puts the sequential focus starting point at the top of the document.
  await page.goto(url, { waitUntil: "load" });
  const problems: string[] = [];
  const links = await page.evaluate(() => document.links.length);
  let stops = 0;
  for (; stops < 60; stops++) {
    await page.keyboard.press("Tab");
    const report = await page.evaluate(inspectFocus);
    if (!report) break;
    if (stops === 0)
      assert.equal(report.name, "a.skip", `${label}: the first tab stop is ${report.name}`);
    if (report.problem) problems.push(`${report.name}: ${report.problem}`);
    if (stops > 0 && report.name === "a.skip") break;
  }
  assert.ok(stops >= links, `${label}: tabbing reached ${stops} stops for ${links} links`);
  assert.deepEqual(problems, [], `${label}: focus rings`);
}

/** Runs in the page: describes the focused element and anything that hides its focus ring. */
function inspectFocus() {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  element.scrollIntoView({ block: "center", behavior: "instant" });
  const name = `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}`;
  const style = getComputedStyle(element);
  const width = parseFloat(style.outlineWidth);
  if (style.outlineStyle === "none" || width < 2) return { name, problem: "no outline" };
  const reach = width + parseFloat(style.outlineOffset);
  const box = element.getBoundingClientRect();
  const ring = {
    left: box.left - reach,
    top: box.top - reach,
    right: box.right + reach,
    bottom: box.bottom + reach,
  };
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent);
    const clip = parent.getBoundingClientRect();
    const clipsX = overflow.overflowX !== "visible";
    const clipsY = overflow.overflowY !== "visible";
    const outX = clipsX && (ring.left < clip.left - 0.5 || ring.right > clip.right + 0.5);
    const outY = clipsY && (ring.top < clip.top - 0.5 || ring.bottom > clip.bottom + 0.5);
    if (outX || outY)
      return {
        name,
        problem: `ring clipped by ${parent.tagName.toLowerCase()}.${parent.className}`,
      };
  }
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (hit && !element.contains(hit) && !hit.contains(element)) return { name, problem: "covered" };
  return { name, problem: "" };
}

async function checkHome(browser: Browser, engine: string, viewport: Viewport) {
  const label = `${engine} ${viewport.name} /`;
  const { context, page, watch } = await open(browser, viewport);
  try {
    await page.goto(url, { waitUntil: "load" });
    const slots = await page.evaluate(() => document.querySelectorAll("#plate .cube").length);
    assert.equal(slots, 16, `${label}: the process table has ${slots} slots`);
    if (viewport.reduce) await checkStill(page, label);
    else await checkLive(page, label, !viewport.touch);
    await eightRows(page, label, viewport.reduce ? 3 : 15);

    assert.deepEqual(await overflowingText(page), [], `${label}: text spills past the right edge`);
    assert.deepEqual(await brokenLinks(page), [], `${label}: links without a target`);
    const links = await hrefs(page);
    for (const doc of ["docs/getting-started.md", "docs/status.md"]) {
      assert.ok(
        links.some((href) => href.endsWith(doc)),
        `${label}: missing link to ${doc}`,
      );
    }
    assert.ok(!links.some((href) => href.includes("/old")), `${label}: links to the old page`);
    const short = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".footer__meta a"))
        .filter((link) => link.getBoundingClientRect().height < 44)
        .map((link) => link.textContent),
    );
    assert.deepEqual(short, [], `${label}: footer links shorter than 44 px`);
    if (!viewport.touch) await focusRings(page, label);

    assert.deepEqual(watch.errors, [], `${label}: browser errors`);
    assert.deepEqual(watch.failed, [], `${label}: failed requests`);
    assert.deepEqual(watch.foreign, [], `${label}: requests to another origin`);
    console.log(`${label}: ok`);
  } finally {
    await context.close();
  }
}

/** Reduced motion: the session shows one still frame and nothing animates after load. */
async function checkStill(page: Page, label: string) {
  const running = await page.evaluate(
    () => document.querySelectorAll("#plate .cube.on:not(.shell)").length,
  );
  assert.equal(
    running,
    3,
    `${label}: the still frame shows ${running} running blocks, not the pipeline`,
  );
  await page.waitForTimeout(500);
  assert.ok(await stillFor(page, 2000), `${label}: the session moved with reduced motion`);
  const animations = await page.evaluate(() => document.getAnimations().length);
  assert.equal(animations, 0, `${label}: ${animations} animations run with reduced motion`);
}

/** Motion: a block rises, the pause button freezes the session, and it stops off screen. */
async function checkLive(page: Page, label: string, desktop: boolean) {
  await page.waitForFunction(
    () => document.querySelector("#plate .cube.on:not(.shell)"),
    undefined,
    {
      timeout: HANG,
    },
  );
  await page.locator("#pause").click();
  await page.waitForTimeout(1500);
  assert.ok(await stillFor(page, 2000), `${label}: the session kept running while paused`);
  await page.locator("#pause").click();
  if (!desktop) return;

  await page.locator("footer").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  assert.ok(await stillFor(page, 2000), `${label}: the session kept running off screen`);
  const paused = await page.evaluate(() =>
    document.getElementById("stage")?.classList.contains("paused"),
  );
  assert.ok(paused, `${label}: the hero's CSS loops kept running off screen`);
  const details = await detailState(page);
  await page.waitForTimeout(2500);
  assert.equal(await detailState(page), details, `${label}: the detail loops ran off screen`);
  await page.locator("#details").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (before) => {
      const now = Array.from(
        document.querySelectorAll("#details .cube, #details .tick, #details .slot"),
        (node) => node.getAttribute("class"),
      ).join();
      return now !== before;
    },
    details,
    { timeout: HANG },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function checkOld(browser: Browser, engine: string, viewport: Viewport) {
  const label = `${engine} ${viewport.name} /old/`;
  const { context, page, watch } = await open(browser, viewport);
  try {
    await page.goto(new URL("old/", url).href, { waitUntil: "load" });
    await page.waitForFunction(
      () =>
        document.querySelector("[data-story]")?.hasAttribute("data-no-gl") ||
        document.querySelector("[data-scene]")?.hasAttribute("data-ready"),
      undefined,
      { timeout: HANG },
    );
    const noGl = await page.evaluate(() =>
      document.querySelector("[data-story]")!.hasAttribute("data-no-gl"),
    );
    const storyEnd = await page.evaluate(() => {
      const story = document.querySelector<HTMLElement>("[data-story]")!;
      return story.offsetTop + story.offsetHeight - window.innerHeight;
    });
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), storyEnd);
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector("[data-blueprint]")!).opacity) < 0.05,
      undefined,
      { timeout: HANG },
    );
    assert.deepEqual(await overflowingText(page), [], `${label}: text spills past the right edge`);
    assert.deepEqual(await brokenLinks(page), [], `${label}: links without a target`);
    const robots = await page.evaluate(() =>
      document.querySelector('meta[name="robots"]')?.getAttribute("content"),
    );
    assert.equal(robots, "noindex", `${label}: not marked noindex`);
    // Without WebGL, three.js logs why it could not create a context; the page then shows its
    // fallback note. Those messages are expected in that case and nothing else is.
    const unexpected = watch.errors.filter(
      (text) => !(noGl && text.startsWith("THREE.WebGLRenderer")),
    );
    assert.deepEqual(unexpected, [], `${label}: browser errors`);
    assert.deepEqual(watch.failed, [], `${label}: failed requests`);
    assert.deepEqual(watch.foreign, [], `${label}: requests to another origin`);
    console.log(`${label}: ok (scene ${noGl ? "no-gl" : "ready"})`);
  } finally {
    await context.close();
  }
}

async function checkMissing(browser: Browser, engine: string, viewport: Viewport) {
  const label = `${engine} ${viewport.name} missing page`;
  const { context, page, watch } = await open(browser, viewport);
  try {
    const response = await page.goto(new URL("no-such-page/", url).href, { waitUntil: "load" });
    assert.equal(response?.status(), 404, `${label}: status ${response?.status()}`);
    const page404 = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      heading: document.querySelector("h1")?.textContent ?? "",
      links: Array.from(document.links, (link) => link.getAttribute("href")),
    }));
    assert.equal(page404.lang, "en", `${label}: lang`);
    assert.ok(page404.title.includes("not found"), `${label}: title ${page404.title}`);
    assert.ok(page404.heading.length > 0, `${label}: no heading`);
    assert.ok(page404.links.includes("/"), `${label}: no link home`);
    assert.ok(
      page404.links.some((href) => href?.endsWith("docs/getting-started.md")),
      `${label}: no Getting started link`,
    );
    assert.deepEqual(await overflowingText(page), [], `${label}: text spills past the right edge`);
    // Chromium logs the document's own 404 status as a console error; that status is the point.
    const unexpected = watch.errors.filter((text) => !text.includes("status of 404"));
    assert.deepEqual(unexpected, [], `${label}: browser errors`);
    assert.deepEqual(watch.foreign, [], `${label}: requests to another origin`);
    console.log(`${label}: ok`);
  } finally {
    await context.close();
  }
}

async function checkEngine(engine: string, failures: string[]) {
  const browser = await engines[engine]!.launch();
  try {
    for (const viewport of viewports) {
      for (const check of [checkHome, checkOld, checkMissing]) {
        await check(browser, engine, viewport).catch((error: unknown) =>
          failures.push(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  } finally {
    await browser.close();
  }
}

const failures: string[] = [];
for (const engine of selected) {
  assert.ok(engines[engine], `Unknown engine ${engine}`);
  await checkEngine(engine, failures);
}
assert.deepEqual(failures, [], `Site smoke check failed:\n${failures.join("\n")}`);
