import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const reference = process.env.REFERENCE_URL ?? 'http://127.0.0.1:4322/';
const candidate = process.env.SITE_URL ?? 'http://127.0.0.1:4323/';
const evidence = process.env.VISIBILITY_EVIDENCE ?? '/work/tmp/waffle-site-visibility.json';
const dt = 1000 / 60;
const angleStep = dt / 1000 * 0.22;
const results: Record<string, unknown>[] = [];
const failures: string[] = [];

// Only the time source and JS animation-frame scheduler are controlled. The
// observer, intersection calculation, callback delivery, canvas and WebGL
// implementation remain Chromium's native implementations.
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const state: any = {
      observers: [], mounts: [], time: 0, scene: null, canvas: null,
      lastAngle: null, frame: null, mounting: false, webglContexts: 0,
    };
    (window as any).__visibility = state;
    let api: any;
    Object.defineProperty(window, 'WaffleScene', {
      configurable: true,
      get: () => api,
      set: (value) => {
        const mount = value.mount;
        value.mount = function (...args: any[]) {
          state.canvas = args[0];
          state.mounting = true;
          try {
            const instance = mount.apply(this, args);
            state.mounts.push({ nonNull: !!instance, canvas: args[0] instanceof HTMLCanvasElement });
            state.scene = instance;
            return instance;
          } finally { state.mounting = false; }
        };
        api = value;
      },
    });

    const NativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = new Proxy(NativeObserver, {
      construct(Target, args) {
        const callback = args[0];
        const record: any = { entries: [], targets: [], requested: args[1] ?? null };
        const observer = new Target((entries, instance) => {
          record.entries = record.entries.concat(entries.map(entry => ({
            isIntersecting: entry.isIntersecting, ratio: entry.intersectionRatio,
            scene: entry.target === state.canvas,
            top: entry.boundingClientRect.top, bottom: entry.boundingClientRect.bottom,
            rootTop: entry.rootBounds?.top, rootBottom: entry.rootBounds?.bottom,
            nativeEntry: entry instanceof IntersectionObserverEntry,
          })));
          callback(entries, instance);
        }, args[1]);
        record.thresholds = observer.thresholds;
        record.rootMargin = observer.rootMargin;
        record.rootNull = observer.root === null;
        record.nativeObserver = observer instanceof NativeObserver;
        const observe = observer.observe;
        observer.observe = function (target) {
          record.targets.push(target);
          return observe.call(this, target);
        };
        state.observers.push(record);
        return observer;
      },
    });

    // placeCamera is the last scene update before the first GL clear. Its last
    // three Math.sin inputs are [elapsed * .22, cameraAzimuth, cameraElevation].
    // Capture at that boundary, before Three's renderer can add its own math.
    // The elapsed angle is an independent clock probe, not just a draw counter.
    const sin = Math.sin;
    Math.sin = function (value) {
      if (state.frame?.scene) state.frame.sinInputs.push(value);
      return sin(value);
    };
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: any[]) {
      const result = (context as any).apply(this, args);
      if (result && (args[0] === 'webgl' || args[0] === 'webgl2' || args[0] === 'experimental-webgl')) {
        state.webglContexts++;
      }
      return result;
    } as typeof context;
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      for (const name of ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const original = (proto as any)[name];
        if (typeof original !== 'function') continue;
        (proto as any)[name] = function (...args: any[]) {
          const frame = state.frame;
          if (frame?.scene && this.canvas === state.canvas) {
            if (name === 'clear') {
              frame.clears++;
              if (!frame.cameraSinTail) frame.cameraSinTail = frame.sinInputs.slice(-3);
            } else frame.draws++;
          }
          return original.apply(this, args);
        };
      }
    }

    const callbacks = new Map<number, { fn: FrameRequestCallback; scene: boolean }>();
    let next = 1;
    Object.defineProperty(performance, 'now', { value: () => state.time });
    window.requestAnimationFrame = (fn) => {
      const id = next++;
      callbacks.set(id, { fn, scene: state.mounting || !!state.frame?.scene });
      return id;
    };
    window.cancelAnimationFrame = id => { callbacks.delete(id); };
    state.advance = (ms = 1000 / 60) => {
      state.time += ms;
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      const frames: any[] = [];
      for (const { fn, scene } of pending) {
        const frame = { scene, draws: 0, clears: 0, sinInputs: [] as number[], cameraSinTail: null as number[] | null };
        state.frame = frame;
        try { fn(state.time); } finally { state.frame = null; }
        if (!scene) continue;
        if (frame.cameraSinTail?.length === 3) state.lastAngle = frame.cameraSinTail[0];
        frames.push({ draws: frame.draws, clears: frame.clears, sinCalls: frame.sinInputs.length, cameraSinTail: frame.cameraSinTail });
      }
      return { time: state.time, lastAngle: state.lastAngle, frames };
    };
    state.observerSnapshot = () => state.observers.filter((record: any) => record.targets.includes(state.canvas)).map((record: any) => ({
      requested: record.requested, thresholds: record.thresholds, rootMargin: record.rootMargin,
      rootNull: record.rootNull, nativeObserver: record.nativeObserver, entries: record.entries,
    }));
  });
}

async function advance(page: Page, milliseconds = dt) {
  return page.evaluate(ms => (window as any).__visibility.advance(ms), milliseconds);
}

async function waitForVisibility(page: Page, visible: boolean) {
  await page.waitForFunction(expected => {
    const state = (window as any).__visibility;
    const observer = state.observerSnapshot().at(-1);
    return observer?.entries.filter((entry: any) => entry.scene).at(-1)?.isIntersecting === expected;
  }, visible, { polling: 25, timeout: 15_000 });
}

function close(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

async function check(page: Page, name: string, url: string) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await instrument(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  for (let i = 0; i < 80; i++) {
    await advance(page, 0);
    if (await page.evaluate(() => !!(window as any).__visibility.scene)) break;
    await page.waitForTimeout(25);
  }
  const mount = await page.evaluate(() => {
    const state = (window as any).__visibility;
    return { mounted: !!state.scene, mounts: state.mounts, webglContexts: state.webglContexts };
  });
  assert.ok(mount.mounted, `${name}: WaffleScene.mount must return an actual scene`);
  assert.ok(mount.webglContexts > 0, `${name}: must use native WebGL, not the poster fallback`);
  assert.ok(mount.mounts.every((item: any) => item.nonNull && item.canvas), `${name}: all mount calls succeed`);
  await waitForVisibility(page, true);
  const observer = (await page.evaluate(() => (window as any).__visibility.observerSnapshot())).at(-1);
  assert.ok(observer.nativeObserver, `${name}: observer is native`);
  assert.deepEqual(observer.requested, { threshold: 0 });
  assert.deepEqual(observer.thresholds, [0]);
  assert.equal(observer.rootMargin, '0px 0px 0px 0px');
  assert.equal(observer.rootNull, true);

  // First calibrate the clock probe over several distinct frame durations. If
  // the selected Math.sin call is not elapsed*.22 these exact slopes fail.
  const calibration = [];
  let previous = await advance(page);
  assert.equal(previous.frames.length, 1, `${name}: exactly one scene frame per tick`);
  assert.ok(previous.frames[0].draws > 0, `${name}: visible scene draws through WebGL`);
  for (const milliseconds of [10, 20, dt, 80]) {
    const next = await advance(page, milliseconds);
    assert.equal(next.frames.length, 1);
    assert.ok(next.frames[0].draws > 0);
    close(next.lastAngle - previous.lastAngle, Math.min(milliseconds / 1000, 0.05) * 0.22, `${name} clock calibration ${milliseconds}ms`);
    calibration.push({ milliseconds, fromAngle: previous.lastAngle, toAngle: next.lastAngle, frame: next.frames[0] });
    previous = next;
  }

  // Scroll actual document geometry beyond the sticky hero and wait for the
  // browser to deliver an actual nonintersecting entry. No synthetic entries.
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  for (let i = 0; i < 3; i++) { await advance(page, 0); await page.waitForTimeout(30); }
  await waitForVisibility(page, false);
  const hiddenGeometry = await page.locator('canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, scrollY };
  });
  assert.ok(hiddenGeometry.bottom < 0 || hiddenGeometry.top > hiddenGeometry.viewportHeight, `${name}: canvas really scrolled outside viewport`);
  const hiddenStart = await advance(page, 0);
  const hidden = [];
  // A full ten seconds of controlled time, while the hidden scene frame still
  // runs each tick. This catches accumulating hidden time even without draws.
  for (let i = 0; i < 200; i++) {
    const frame = await advance(page, 50);
    assert.equal(frame.frames.length, 1, `${name}: hidden scene callback remains scheduled`);
    assert.equal(frame.frames[0].draws, 0, `${name}: hidden scene must not draw`);
    assert.equal(frame.frames[0].clears, 0, `${name}: hidden scene must not clear`);
    assert.equal(frame.frames[0].sinCalls, 0, `${name}: hidden scene must not update animation math`);
    close(frame.lastAngle, hiddenStart.lastAngle, `${name}: hidden clock probe remains frozen`);
    if (i === 0 || i === 199) hidden.push(frame);
  }

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  // Wait in real browser time only: do not consume the first resumed scene
  // frame until the native observer has reported intersection again.
  await waitForVisibility(page, true);
  const resumed = await advance(page);
  assert.equal(resumed.frames.length, 1);
  assert.ok(resumed.frames[0].draws > 0, `${name}: native WebGL resumes when visible`);
  close(resumed.lastAngle - hiddenStart.lastAngle, angleStep, `${name}: resumed elapsed advances by one frame, not hidden wall duration`);
  const visibleAgain = await advance(page);
  close(visibleAgain.lastAngle - resumed.lastAngle, angleStep, `${name}: visible clock continues advancing`);
  const observers = await page.evaluate(() => (window as any).__visibility.observerSnapshot());
  assert.ok(observers.every((item: any) => item.entries.every((entry: any) => entry.nativeEntry)), `${name}: all entries are native`);
  assert.equal(errors.length, 0, `${name}: no uncaught browser errors: ${errors.join('; ')}`);
  return { name, url, mount, options: { requested: observer.requested, thresholds: observer.thresholds, rootMargin: observer.rootMargin, rootNull: observer.rootNull }, calibration, hiddenGeometry, hiddenStart, hiddenDurationMs: 10_000, hidden, resumed, visibleAgain, observers, errors };
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [name, url] of [['reference', reference], ['astro-dist', candidate]]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' });
    try {
      const result = await check(await context.newPage(), name!, url!);
      results.push(result);
      console.log(JSON.stringify({ name, status: 'passed', hiddenDurationMs: result.hiddenDurationMs, beforeAngle: result.hiddenStart.lastAngle, resumedAngle: result.resumed.lastAngle }));
    } catch (error) {
      const message = `${name}: ${error instanceof Error ? error.stack : String(error)}`;
      failures.push(message);
      console.error(message);
    } finally { await context.close(); }
  }
  if (results.length === 2) assert.deepEqual(results[0]!.options, results[1]!.options, 'native observer options match reference and Astro');
} finally {
  await browser.close();
  await writeFile(evidence, JSON.stringify({ reference, candidate, engine: 'chromium', nativeIntersectionObserver: true, dt, results, failures, cleanup: { browserClosed: true, contextsClosed: true } }, null, 2));
}
assert.equal(failures.length, 0, `Native scene visibility verification failed; inspect ${evidence}`);
