import { chromium, type CDPSession } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import os from 'node:os';

// Run through the shared heavy runner, never alongside an unowned browser job:
// PLAYWRIGHT_BROWSERS_PATH=/work/cache/ms-playwright bun /work/platform-production/heavy/current/run.js --class browser waffle-site-performance -- bun site/scripts/performance.ts
// This is a lab diagnostic, NOT Lighthouse and NOT a Lighthouse performance score.
const mode = process.env.PERF_MODE ?? 'three-way';
if (!['three-way', 'abba'].includes(mode)) throw new Error('PERF_MODE must be three-way or abba');
const blocks = Number(process.env.ABBA_BLOCKS ?? 5);
if (!Number.isInteger(blocks) || blocks < 1 || blocks > 25) throw new Error('ABBA_BLOCKS must be an integer from 1 through 25');
const output = process.env.PERFORMANCE_OUTPUT ?? (mode === 'abba' ? '/work/tmp/waffle-site-performance-abba.json' : '/work/tmp/waffle-site-performance.json');
const baselinePath = process.env.BASELINE_HTML ?? '/work/tmp/waffle-site-extracted/outer/281df726-0eff-4ae0-a4d0-749fd2cd790e.html';
const ownerPath = process.env.OWNER_HTML ?? '/work/tmp/waffle-site-reference/waffle-website.html';
const candidateUrl = process.env.SITE_URL ?? 'http://127.0.0.1:4323/';
const extractedUrl = process.env.REFERENCE_URL ?? 'http://127.0.0.1:4322/';
const observationMs = 8_000;
const repeats = mode === 'abba' ? blocks : 3;
const hostSnapshot = () => {
  const ticks = os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
  return { at: new Date().toISOString(), uptimeSeconds: os.uptime(), loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(), ...ticks };
};
const compressionCache = new Map<string, { raw: number; gzip: number; brotli: number }>();

function sizes(body: Buffer) {
  const hash = createHash('sha256').update(body).digest('hex');
  let result = compressionCache.get(hash);
  if (!result) {
    result = {
      raw: body.length,
      gzip: gzipSync(body, { level: 9 }).length,
      brotli: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    };
    compressionCache.set(hash, result);
  }
  return result;
}

const baseline = await readFile(baselinePath);
// This server and Chromium's temporary profile are the only task-created resources.
// Reuse the two existing comparison servers without taking ownership of them.
const server = createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': baseline.length, 'Cache-Control': 'no-store' });
  res.end(baseline);
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let interrupted = false;
const cleanup = async () => {
  await browser?.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
};
const interrupt = () => {
  interrupted = true;
  void cleanup().finally(() => process.exit(130));
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing baseline server address');
  const bundledTarget = { name: 'bundled-reference', url: `http://127.0.0.1:${address.port}/` };
  const candidateTarget = { name: 'astro-candidate', url: candidateUrl };
  const targets = mode === 'abba' ? [bundledTarget, candidateTarget] : [bundledTarget, { name: 'extracted-reference', url: extractedUrl }, candidateTarget];
  browser = await chromium.launch({ headless: true, ...(mode === 'abba' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) });
  const runs: Record<string, unknown>[] = [];
  const sampleCounts = new Map<string, number>();
  for (let repeat = 1; repeat <= repeats; repeat++) {
    // ABBA brackets each pair of candidate observations with original samples,
    // cancelling linear host drift in each four-sample block's mean contrast.
    const ordered = mode === 'abba' ? [bundledTarget, candidateTarget, candidateTarget, bundledTarget] : repeat % 2 === 0 ? targets.toReversed() : targets;
    for (const [position, target] of ordered.entries()) {
      if (interrupted) throw new Error('Interrupted');
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        const session: CDPSession = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        await session.send('Performance.enable');
        const resources = new Map<string, { url: string; type?: string; status?: number; contentEncoding?: string; wireBytes?: number; body?: Buffer; error?: string }>();
        const pendingBodies: Promise<void>[] = [];
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        session.on('Network.requestWillBeSent', event => {
          if (/^https?:/.test(event.request.url)) resources.set(event.requestId, { url: event.request.url, type: event.type });
        });
        session.on('Network.responseReceived', event => {
          const resource = resources.get(event.requestId);
          if (resource) {
            resource.status = event.response.status;
            resource.contentEncoding = String(event.response.headers['content-encoding'] ?? event.response.headers['Content-Encoding'] ?? 'identity');
          }
        });
        session.on('Network.loadingFailed', event => {
          const resource = resources.get(event.requestId);
          if (resource) resource.error = event.errorText;
        });
        session.on('Network.loadingFinished', event => {
          const resource = resources.get(event.requestId);
          if (!resource) return;
          resource.wireBytes = event.encodedDataLength;
          pendingBodies.push(session.send('Network.getResponseBody', { requestId: event.requestId }).then(result => {
            resource.body = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
          }).catch(error => { resource.error = String(error); }));
        });
        await page.addInitScript((cutoffMs: number) => {
          type Entry = PerformanceEntry & { value?: number; hadRecentInput?: boolean; element?: Element; duration: number };
          const data = { lcp: 0, lcpElement: '', shifts: [] as { time: number; value: number }[], longTasks: [] as { start: number; duration: number }[] };
          (window as unknown as { __lab: typeof data }).__lab = data;
          new PerformanceObserver(list => {
            for (const entry of list.getEntries() as Entry[]) if (entry.startTime < cutoffMs) { data.lcp = entry.startTime; data.lcpElement = entry.element?.tagName ?? ''; }
          }).observe({ type: 'largest-contentful-paint', buffered: true });
          new PerformanceObserver(list => {
            for (const entry of list.getEntries() as Entry[]) if (!entry.hadRecentInput && entry.startTime < cutoffMs) data.shifts.push({ time: entry.startTime, value: entry.value ?? 0 });
          }).observe({ type: 'layout-shift', buffered: true });
          new PerformanceObserver(list => {
            for (const entry of list.getEntries()) if (entry.startTime < cutoffMs) data.longTasks.push({ start: entry.startTime, duration: entry.duration });
          }).observe({ type: 'longtask', buffered: true });
        }, observationMs);
        const hostBefore = hostSnapshot();
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(Math.max(0, observationMs - await page.evaluate(() => performance.now())));
        const metrics = await page.evaluate((observationEndMs: number) => {
          const data = (window as unknown as { __lab: { lcp: number; lcpElement: string; shifts: { time: number; value: number }[]; longTasks: { start: number; duration: number }[] } }).__lab;
          const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
          // CLS uses the standard max session window (1-second gaps, max 5 seconds), not a lifetime sum.
          let cls = 0, score = 0, first = 0, previous = -Infinity;
          for (const shift of data.shifts) {
            if (shift.time - previous > 1000 || shift.time - first > 5000) { score = 0; first = shift.time; }
            score += shift.value; previous = shift.time; cls = Math.max(cls, score);
          }
          const collectedAtMs = performance.now();
          const blocking = (from: number, to: number) => data.longTasks.reduce((total, task) => total + Math.max(0, Math.min(task.start + task.duration, to) - Math.max(task.start + 50, from)), 0);
          const canvas = document.querySelector('canvas');
          const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
          const rendererInfo = gl?.getExtension('WEBGL_debug_renderer_info');
          return {
            observationEndMs,
            collectedAtMs,
            webglRenderer: gl && rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) as string : null,
            firstContentfulPaintMs: fcp,
            largestContentfulPaintMs: data.lcp || null,
            largestContentfulPaintElement: data.lcpElement,
            cumulativeLayoutShift: cls,
            totalBlockingTimeAfterFcpMs: fcp === null ? null : blocking(fcp, observationEndMs),
            navigationBlockingTimeMs: blocking(0, observationEndMs),
            blockingByWindow: [[0, 1000], [1000, 2000], [2000, 4000], [4000, 8000]].map(([from, to]) => ({ fromMs: from!, toMs: to!, navigationBlockingMs: blocking(from!, to!), postFcpBlockingMs: fcp === null ? null : blocking(Math.max(from!, fcp), to!) })),
            steadyStateBlockingAfterTwoSecondsMs: blocking(2000, observationEndMs),
            longTaskCount: data.longTasks.length,
            longTaskTotalMs: data.longTasks.reduce((total, task) => total + Math.min(task.duration, observationEndMs - task.start), 0),
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
            loadMs: navigation.loadEventEnd,
            ready: { heading: document.querySelector('h1')?.textContent?.trim() ?? null, canvas: !!document.querySelector('canvas'), fonts: document.fonts.status, bundleError: document.querySelector('#__bundler_err')?.textContent ?? null },
            longTasks: data.longTasks,
          };
        }, observationMs);
        const hostAfter = hostSnapshot();
        const cdpPerformance = Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
        // Freeze the inventory, finish response capture, then stop the scene
        // before compression so analysis cannot extend any sample's GPU work.
        const captured = Array.from(resources.values());
        await Promise.all(pendingBodies);
        await page.close();
        const inventory = captured.map(resource => ({
          url: resource.url, type: resource.type, status: resource.status, contentEncoding: resource.contentEncoding,
          wireBytes: resource.wireBytes ?? 0,
          sha256: resource.body ? createHash('sha256').update(resource.body).digest('hex') : null,
          ...(resource.body ? sizes(resource.body) : { raw: 0, gzip: 0, brotli: 0 }),
          ...(resource.error ? { error: resource.error } : {}),
        }));
        const totals = inventory.reduce((sum, resource) => ({ requests: sum.requests + 1, raw: sum.raw + resource.raw, gzip: sum.gzip + resource.gzip, brotli: sum.brotli + resource.brotli, wireBytes: sum.wireBytes + resource.wireBytes }), { requests: 0, raw: 0, gzip: 0, brotli: 0, wireBytes: 0 });
        const sample = (sampleCounts.get(target.name) ?? 0) + 1;
        sampleCounts.set(target.name, sample);
        const totalTicks = hostAfter.total - hostBefore.total;
        const hostCpuBusyPercent = totalTicks > 0 ? 100 * (1 - (hostAfter.idle - hostBefore.idle) / totalTicks) : null;
        const run = { target: target.name, repeat: sample, block: mode === 'abba' ? repeat : null, positionInBlock: position + 1, host: { before: hostBefore, after: hostAfter, cpuBusyPercent: hostCpuBusyPercent }, cdpPerformance, metrics, totals, resources: inventory, pageErrors, consoleErrors };
        runs.push(run);
        console.log(JSON.stringify(run));
      } finally {
        await context.close();
      }
    }
  }
  const metricNames = ['firstContentfulPaintMs', 'largestContentfulPaintMs', 'cumulativeLayoutShift', 'totalBlockingTimeAfterFcpMs', 'navigationBlockingTimeMs', 'steadyStateBlockingAfterTwoSecondsMs', 'longTaskCount', 'longTaskTotalMs', 'domContentLoadedMs', 'loadMs'];
  const distribution = (values: number[]) => {
    values.sort((a, b) => a - b);
    const quantile = (p: number) => {
      if (values.length === 0) return null;
      const index = (values.length - 1) * p;
      const lower = Math.floor(index);
      return values[lower]! + (values[Math.ceil(index)]! - values[lower]!) * (index - lower);
    };
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return { count: values.length, min: values[0] ?? null, p25: quantile(0.25), median: quantile(0.5), p75: quantile(0.75), max: values.at(-1) ?? null, mean, sampleStandardDeviation: values.length > 1 && mean !== null ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null };
  };
  const metric = (run: Record<string, unknown>, key: string) => (run.metrics as Record<string, number>)[key]!;
  const summaries = targets.map(target => {
    const selected = runs.filter(run => run.target === target.name);
    const distributions = Object.fromEntries(metricNames.map(key => [key, distribution(selected.map(run => metric(run, key)).filter(value => typeof value === 'number'))]));
    return { target: target.name, medianMetrics: Object.fromEntries(metricNames.map(key => [key, distributions[key]!.median])), distributions, perRunMetrics: selected.map(run => ({ repeat: run.repeat, block: run.block, positionInBlock: run.positionInBlock, ...Object.fromEntries(metricNames.map(key => [key, metric(run, key)])) })), perRunTotals: selected.map(run => run.totals) };
  });
  const blockComparisons = mode === 'abba' ? Array.from({ length: blocks }, (_, index) => {
    const selected = runs.filter(run => run.block === index + 1);
    const original = selected.filter(run => run.target === 'bundled-reference');
    const candidate = selected.filter(run => run.target === 'astro-candidate');
    return { block: index + 1, candidateMinusOriginal: Object.fromEntries(metricNames.map(key => [key, (metric(candidate[0]!, key) + metric(candidate[1]!, key) - metric(original[0]!, key) - metric(original[1]!, key)) / 2])) };
  }) : [];
  const blockDeltaDistributions = mode === 'abba' ? Object.fromEntries(metricNames.map(key => [key, distribution(blockComparisons.map(block => block.candidateMinusOriginal[key]!))])) : null;
  const validationFailures: string[] = [];
  if (runs.length !== (mode === 'abba' ? blocks * 4 : 9)) validationFailures.push('Unexpected total sample count');
  const signatures = new Map<string, string>();
  const renderers = new Set<string>();
  for (const target of targets) if (sampleCounts.get(target.name) !== (mode === 'abba' ? blocks * 2 : 3)) validationFailures.push(`Unexpected ${target.name} sample count`);
  for (const [index, run] of runs.entries()) {
    const metrics = run.metrics as Record<string, unknown>;
    for (const key of metricNames) if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key])) validationFailures.push(`Sample ${index + 1}: invalid ${key}`);
    if (metrics.observationEndMs !== observationMs || typeof metrics.collectedAtMs !== 'number' || metrics.collectedAtMs < observationMs) validationFailures.push(`Sample ${index + 1}: invalid observation window`);
    const windows = metrics.blockingByWindow as { navigationBlockingMs: number; postFcpBlockingMs: number }[];
    if (windows.length !== 4 || windows.some(window => !Number.isFinite(window.navigationBlockingMs) || !Number.isFinite(window.postFcpBlockingMs))) validationFailures.push(`Sample ${index + 1}: invalid blocking buckets`);
    if (typeof metrics.webglRenderer === 'string') renderers.add(metrics.webglRenderer);
    const ready = metrics.ready as { heading?: string; canvas?: boolean; fonts?: string; bundleError?: string | null };
    if (!ready.heading || !ready.canvas || ready.fonts !== 'loaded' || ready.bundleError) validationFailures.push(`Sample ${index + 1}: incomplete page readiness`);
    if ((run.pageErrors as string[]).length || (run.consoleErrors as string[]).length) validationFailures.push(`Sample ${index + 1}: page/console errors`);
    if (mode === 'abba' && (typeof metrics.webglRenderer !== 'string' || !metrics.webglRenderer.includes('SwiftShader'))) validationFailures.push(`Sample ${index + 1}: renderer is not SwiftShader`);
    const resources = run.resources as { url: string; status?: number; raw: number; sha256: string | null; error?: string }[];
    if (resources.length === 0 || resources.some(resource => resource.status === undefined || resource.status >= 400 || resource.error || resource.raw <= 0 || !resource.sha256)) validationFailures.push(`Sample ${index + 1}: unsuccessful HTTP response capture`);
    const signature = JSON.stringify(resources.map(resource => ({ url: resource.url, sha256: resource.sha256 })).sort((a, b) => a.url.localeCompare(b.url)));
    const previous = signatures.get(run.target as string);
    if (previous !== undefined && previous !== signature) validationFailures.push(`Sample ${index + 1}: resources changed during measurement`);
    signatures.set(run.target as string, signature);
  }
  if (mode === 'abba' && renderers.size !== 1) validationFailures.push('WebGL renderer changed across samples');
  const report = {
    createdAt: new Date().toISOString(),
    method: 'Chromium CDP + buffered PerformanceObserver; no Lighthouse score',
    protocol: { mode, blocks: mode === 'abba' ? blocks : null, order: mode === 'abba' ? 'ABBA; A=bundled-reference, B=astro-candidate' : 'three-way alternating order', samplesPerTarget: mode === 'abba' ? blocks * 2 : 3, fixedWindowMs: observationMs, sceneClosedBeforeCompression: true, forcedSwiftShader: mode === 'abba' },
    validation: { passed: validationFailures.length === 0, failures: validationFailures },
    environment: { hostname: os.hostname(), platform: os.platform(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, browser: browser.version(), viewport: { width: 1280, height: 800 }, repeats, observationMs, networkThrottling: 'none (loopback)', cpuThrottling: 'none', cache: 'fresh context per run; CDP cache disabled', loadAverageAtEnd: os.loadavg() },
    caveats: [
      'Not Lighthouse: no performance score, mobile emulation, throttled network/CPU, or TTI calculation.',
      'Blocking time is sum(max(task duration - 50 ms, 0)) after FCP through the fixed observation end, not Lighthouse TBT through TTI.',
      'Loopback timings are same-host diagnostics; shared heavy-runner jobs and software WebGL may affect CPU timings.',
      'wireBytes are CDP encodedDataLength including response overhead. raw/gzip/brotli are decoded HTTP response-body bytes and modeled per-response gzip-9/Brotli-11 sizes, excluding headers; gzip/Brotli were not actually served.',
      'Blob/data resources embedded in bundled HTML are not additional HTTP requests or additional transferred bytes.',
      'The full owner HTML contains three design boards; it is size context only, not the landing baseline. Bundled-reference is the actual nested standalone landing. Extracted-reference removes bundler overhead but retains React/DC.',
      'Readiness, console errors, failed responses and resource URLs are retained to expose invalid/font-blocked baselines rather than treating incomplete loads as wins.',
    ],
    sourceFiles: await Promise.all([{ role: 'full-owner-three-design-boards-size-context-only', path: ownerPath }, { role: 'standalone-landing-baseline', path: baselinePath }].map(async file => ({ ...file, ...sizes(await readFile(file.path)) }))),
    summaries,
    blockComparisons,
    blockDeltaDistributions,
    runs,
    cleanup: { browserClosed: false, ownedBaselineServerClosed: false, existingServersPreserved: [extractedUrl, candidateUrl] },
  };
  await cleanup();
  report.cleanup.browserClosed = true;
  report.cleanup.ownedBaselineServerClosed = !server.listening;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Saved ${output}`);
  if (validationFailures.length) throw new Error(`Invalid performance report: ${validationFailures.join('; ')}`);
} finally {
  await cleanup();
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
