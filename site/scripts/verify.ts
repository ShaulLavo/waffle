import { chromium, firefox, webkit, type BrowserType, type Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reference = process.env.REFERENCE_URL ?? 'http://127.0.0.1:4322/';
const candidate = process.env.SITE_URL ?? 'http://127.0.0.1:4323/';
const evidence = process.env.EVIDENCE_DIR ?? '/work/tmp/waffle-site-evidence';
const engines: [string, BrowserType][] = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]];
const engineNames = engines.map(([name]) => name);
const selectedEngines = process.env.ENGINES === undefined ? engineNames : process.env.ENGINES.split(',').map(name => name.trim());
if (selectedEngines.some(name => !engineNames.includes(name)) || new Set(selectedEngines).size !== selectedEngines.length) {
  throw new Error(`ENGINES must select unique names from ${engineNames.join(',')}`);
}
const widths = process.env.WIDTHS === undefined ? [375, 768, 1280, 1920] : process.env.WIDTHS.split(',').map(Number);
if (widths.some(width => !Number.isInteger(width) || width < 1 || width > 3840) || new Set(widths).size !== widths.length) {
  throw new Error('WIDTHS must select unique integer widths between 1 and 3840');
}
const expectedCases = selectedEngines.length * widths.length * 13;
await mkdir(evidence, { recursive: true });
const results: Record<string, unknown>[] = [];
const failures: string[] = [];

async function prepare(page: Page, url: string) {
  await page.addInitScript(() => {
    if ((window as any).__advance) return;
    let api: any;
    Object.defineProperty(window, 'WaffleScene', {
      configurable: true,
      get: () => api,
      set: (value) => {
        const mount = value.mount;
        value.mount = (...args: any[]) => {
          const instance = mount(...args);
          (window as any).__scene = instance;
          return instance;
        };
        api = value;
      },
    });
    // Deliver scene visibility at the same synthetic frame boundary on both
    // pages, rather than letting full-page capture schedule native IO at
    // different wall-clock times. Intersection geometry is still measured.
    const observers = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>();
    (window as any).IntersectionObserver = class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe(target: Element) { observers.set(target, this.callback); }
      unobserve(target: Element) { observers.delete(target); }
      disconnect() {
        for (const [target, callback] of observers) if (callback === this.callback) observers.delete(target);
      }
    };
    const callbacks = new Map<number, FrameRequestCallback>();
    let next = 1;
    let time = 0;
    Object.defineProperty(performance, 'now', { value: () => time });
    Date.now = () => 1_800_000_000_000;
    window.requestAnimationFrame = (fn) => { const id = next++; callbacks.set(id, fn); return id; };
    window.cancelAnimationFrame = (id) => { callbacks.delete(id); };
    (window as any).__advance = (ms = 1000 / 60) => {
      for (const [target, callback] of observers) {
        const rect = target.getBoundingClientRect();
        callback([{ isIntersecting: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth }]);
      }
      time += ms;
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      for (const fn of pending) fn(time);
    };
  });
  await page.mouse.move(0, 0);
  await page.goto(url, { waitUntil: 'networkidle' });
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => (window as any).__advance(0));
    await page.waitForTimeout(30);
  }
  await page.waitForFunction(() => !!document.querySelector('canvas') && !!(window as any).__scene);
  await page.evaluate(async () => { await document.fonts.ready; });
  // Give original React and the Astro controller equal deterministic frame time.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      document.querySelector('canvas')?.dispatchEvent(new PointerEvent('pointerleave'));
      (window as any).__advance();
    });
    await page.waitForTimeout(0);
  }
}

async function settle(page: Page, progress: number) {
  await page.evaluate((p) => {
    document.querySelector('canvas')?.dispatchEvent(new PointerEvent('pointerleave'));
    const hero = document.querySelector('[data-scrolly]')!;
    window.scrollTo(0, hero.getBoundingClientRect().top + scrollY + (hero.getBoundingClientRect().height - innerHeight) * p);
  }, progress);
  // Both implementations receive the same settled scroll value before stepping
  // time. This isolates the visuals from React's different scheduling phase.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as any).__advance(0));
    await page.waitForTimeout(10);
  }
  await page.evaluate((p) => (window as any).__scene.setProgress(p, true), progress);
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => (window as any).__advance());
    await page.waitForTimeout(0);
  }
}

for (const [engine, type] of engines) {
  if (!selectedEngines.includes(engine)) continue;
  const browser = await type.launch({ headless: process.env.HEADFUL !== '1' });
  try {
    for (const width of widths) {
      const pages = await Promise.all([reference, candidate].map(async (url) => {
        const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' });
        page.on('pageerror', error => failures.push(`${engine}/${width}: ${error.message}`));
        page.on('requestfailed', request => failures.push(`${engine}/${width}: ${request.url()}: ${request.failure()?.errorText}`));
        page.on('response', response => {
          if (response.status() >= 400) failures.push(`${engine}/${width}: ${response.status()} ${response.url()}`);
        });
        await prepare(page, url);
        return page;
      }));
      const inventory = async (page: Page) => page.evaluate(() => ({
        text: document.body.innerText,
        links: Array.from(document.querySelectorAll('a')).filter(a => a.getClientRects().length > 0).map(a => ({ text: a.innerText.replace(/\s+/g, ' ').trim(), href: a.getAttribute('href') })),
      }));
      const [before, after] = await Promise.all(pages.map(inventory));
      await writeFile(path.join(evidence, `${engine}-${width}-inventory.json`), JSON.stringify({before,after},null,2));
      const textEqual = before!.text === after!.text;
      const linksEqual = JSON.stringify(before!.links) === JSON.stringify(after!.links);
      const capture = async (state: string, fullPage = false) => {
        const file = `${engine}-${width}-${state}`;
        await Promise.all(pages.map(async page => {
          await page.locator('canvas').evaluate(canvas => {
            const gl = (canvas as HTMLCanvasElement).getContext('webgl2') ?? (canvas as HTMLCanvasElement).getContext('webgl');
            gl?.finish();
          });
          // WebGL submission and browser composition are separate. Allow both
          // pages to commit the already-stepped frame without advancing time.
          await page.waitForTimeout(80);
        }));
        const [a, b] = await Promise.all(pages.map((page, i) => page.screenshot({ path: path.join(evidence, `${file}-${i === 0 ? 'before' : 'after'}.png`), fullPage, animations: 'disabled' })));
        const aa = PNG.sync.read(a!); const bb = PNG.sync.read(b!);
        let pixels: number | null = null;
        if (aa.width === bb.width && aa.height === bb.height) {
          const diff = new PNG({ width: aa.width, height: aa.height });
          pixels = pixelmatch(aa.data, bb.data, diff.data, aa.width, aa.height, { threshold: 0.1, includeAA: false });
          await writeFile(path.join(evidence, `${file}-diff.png`), PNG.sync.write(diff));
        }
        const sceneCursors = await Promise.all(pages.map(page => page.locator('canvas').evaluate(canvas => canvas.style.cursor)));
        const row = { engine, width, state, textEqual, linksEqual, sceneCursors, before: [aa.width, aa.height], after: [bb.width, bb.height], diffPixels: pixels, diffRatio: pixels === null ? null : pixels / (aa.width * aa.height) };
        results.push(row);
        await writeFile(path.join(evidence, 'visual-diff.json'), JSON.stringify({ reference, candidate, threshold: 0.1, includeAA: false, failures, results }, null, 2));
        console.log(JSON.stringify(row));
      };
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        await Promise.all(pages.map(page => settle(page, progress)));
        await capture(`p${Math.round(progress * 100)}`, progress === 0);
      }
      // CSS states: real hover/focus on both kinds of clickable surface.
      for (const selector of ['#today a.wbtn', 'a.wtile']) {
        const label = selector.includes('wtile') ? 'tile' : 'button';
        await Promise.all(pages.map(async page => {
          const target = page.locator(selector).filter({ visible: true }).first();
          await target.scrollIntoViewIfNeeded();
          await target.hover();
        }));
        await capture(`${label}-hover`);
        await Promise.all(pages.map(async page => {
          await page.mouse.move(0, 0);
          await page.locator(selector).filter({ visible: true }).first().focus();
        }));
        await capture(`${label}-focus`);
      }
      // Start pointer/click tests from fresh scenes: scrolling offscreen for
      // link tests intentionally pauses each renderer at observer delivery time.
      await Promise.all(pages.map((page, i) => prepare(page, i === 0 ? reference : candidate)));
      await Promise.all(pages.map(page => settle(page, 1)));
      const pointer = { x: Math.round(width * (width < 860 ? 0.5 : 0.75)), y: 590 };
      await Promise.all(pages.map(async page => {
        await page.mouse.move(pointer.x, pointer.y);
        await page.waitForTimeout(30);
        for (let i = 0; i < 10; i++) await page.evaluate(() => (window as any).__advance());
      }));
      await capture('scene-pointer');
      await Promise.all(pages.map(page => page.mouse.click(pointer.x, pointer.y)));
      await capture('scene-click-0ms');
      for (const [frames, label] of [[15, '250ms'], [45, '1000ms']] as const) {
        for (let i = 0; i < frames; i++) await Promise.all(pages.map(page => page.evaluate(() => (window as any).__advance())));
        await capture(`scene-click-${label}`);
      }
      await Promise.all(pages.map(page => page.close()));
    }
  } finally { await browser.close(); }
}
await writeFile(path.join(evidence, 'visual-diff.json'), JSON.stringify({ reference, candidate, threshold: 0.1, includeAA: false, failures, results }, null, 2));

if (results.length !== expectedCases || failures.length || results.some(row => row.diffPixels !== 0 || !row.textEqual || !row.linksEqual)) {
  throw new Error('Visual or content parity failed; inspect visual-diff.json');
}
