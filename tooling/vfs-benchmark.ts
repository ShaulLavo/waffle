import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, hostname, release, totalmem } from "node:os";
import type { BrowserContext, Page } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "../tests/browser-runner-lifecycle.js";
import { BROWSERS, WORKLOADS, LANES, SAMPLING, SCORE_PROTOCOL, FIXTURE_SEED, pairOrder, type BrowserName, type Lane, type Workload } from "./vfs-score-config.js";
import { score, type Sample } from "./vfs-score.js";
import type { BrowserRequest, BrowserResult } from "./vfs-browser.js";

import { parseCells, assertSelectionScope, compareContinuation } from "./vfs-continuation.js";

const PREFIX = "VFS_EVIDENCE ";
interface Options { output: string; campaign: string; revision: string; browsers: BrowserName[]; workloads: Workload[]; lanes: Lane[]; cells?: Set<string>; continuationOf?: string; mode: "screening" | "promotion"; candidateRoot?: string; candidateRevision?: string; initialBaseline?: string; acceptedSummary?: string; extract?: string; }
function argumentsFor(args: string[]): Options {
  const options: Options = { output: "", campaign: "", revision: "", browsers: Array.from(BROWSERS), workloads: Array.from(WORKLOADS), lanes: Array.from(LANES), mode: "screening" };
  const list = <T extends string>(value: string, allowed: readonly T[]): T[] => {
    const values = value.split(","); if (!values.length || new Set(values).size !== values.length || values.some(v => !allowed.includes(v as T))) throw new Error(`Invalid selection ${value}`); return values as T[];
  };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1]; if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--output") options.output = resolve(value);
    else if (flag === "--campaign") options.campaign = value;
    else if (flag === "--browsers") options.browsers = list(value, BROWSERS);
    else if (flag === "--workloads") options.workloads = list(value, WORKLOADS);
    else if (flag === "--lanes") options.lanes = list(value, LANES);
    else if (flag === "--cells") options.cells = parseCells(value);
    else if (flag === "--continuation-of") options.continuationOf = value;
    else if (flag === "--mode" && (value === "screening" || value === "promotion")) options.mode = value;
    else if (flag === "--candidate-root") options.candidateRoot = resolve(value);
    else if (flag === "--initial-baseline") options.initialBaseline = resolve(value);
    else if (flag === "--accepted-summary") options.acceptedSummary = resolve(value);
    else if (flag === "--extract") options.extract = resolve(value);
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!options.output) throw new Error("--output must be an external evidence directory");
  const repo = resolve(import.meta.dir, "..");
  if (options.output === repo || options.output.startsWith(`${repo}/`)) throw new Error("Evidence must not be stored in the repository");
  if (!options.extract && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(options.campaign))) throw new Error("Need --campaign ID");
  if (!options.extract && options.mode === "promotion" && !options.candidateRoot) throw new Error("Promotion requires --candidate-root");
  if (!options.extract && options.candidateRoot && (!options.initialBaseline || !options.acceptedSummary)) throw new Error("Promotion requires --initial-baseline and --accepted-summary; neither initial normalization nor the accepted ratchet may reset");
  if (options.cells) assertSelectionScope(options.cells, options.browsers, options.workloads, options.lanes);
  if (options.continuationOf && !options.cells) throw new Error("Continuation requires an explicit --cells selection");
  return options;
}
/** Labels come from the immutable source, never CLI text. The remote dispatcher
 * verifies its archive, and this check additionally binds the reconstructed Git
 * tree to its manifest and rejects any edited or untracked source. */
export function sourceRevision(root: string, manifest?: { source_commit: string }): string {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root].concat(args));
    if (result.exitCode) throw new Error(`Source provenance check failed: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const revision = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Missing immutable source revision");
  if (manifest && manifest.source_commit !== revision) throw new Error("Source HEAD differs from dispatcher manifest");
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Campaign source must be clean and committed");
  return revision;
}
async function treeSize(path: string): Promise<{ logical: number; physical: number }> {
  let logical = 0, physical = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { const value = await treeSize(child); logical += value.logical; physical += value.physical; }
    else { const value = await stat(child); logical += value.size; physical += value.blocks * 512; }
  }
  return { logical, physical };
}
async function environment() {
  const get = (path: string) => readFile(path, "utf8").catch(() => "unavailable");
  return { at: new Date().toISOString(), load: await get("/proc/loadavg"), cpu: await get("/proc/stat"), memory: await get("/proc/meminfo"), memoryPressure: await get("/proc/pressure/memory"), ioPressure: await get("/proc/pressure/io") };
}
function invalidReason(before: Awaited<ReturnType<typeof environment>>, after: Awaited<ReturnType<typeof environment>>): string | undefined {
  const cpu = (text: string) => text.split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
  const a = cpu(before.cpu), b = cpu(after.cpu);
  if (!a.length || a.some(v => !Number.isFinite(v)) || b.length !== a.length) return "CPU observations unavailable";
  const total = b.slice(0, 8).reduce((sum, value, i) => sum + value - a[i]!, 0), steal = b[7]! - a[7]!;
  if (total > 0 && steal / total > 0.01) return `CPU steal ${(100 * steal / total).toFixed(2)}% exceeds fixed 1% limit`;
  const available = Number(/MemAvailable:\s+(\d+)/.exec(after.memory)?.[1] ?? 0);
  if (available < 512 * 1024) return "Host available memory below 512 MiB";
  if (Number(/full avg10=([\d.]+)/.exec(after.memoryPressure)?.[1] ?? 0) > 1) return "Memory full-pressure avg10 exceeds 1%";
  return;
}
async function controllerRss(): Promise<number> {
  // Only our process and descendants; no PID-name matching or shared-host process kills.
  const visit = async (pid: number): Promise<number> => {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
      return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024 + (await Promise.all(children.map(visit))).reduce((a, b) => a + b, 0);
    } catch { return 0; }
  };
  return visit(process.pid);
}
async function worker(page: Page, request: BrowserRequest): Promise<BrowserResult> {
  return page.evaluate(input => {
    const global = globalThis as typeof globalThis & { benchmarkWorker?: Worker; vfsAck?: (value: unknown) => Promise<void> };
    global.benchmarkWorker ??= new Worker("/benchmark.js", { type: "module" });
    const instance = global.benchmarkWorker;
    return new Promise<BrowserResult>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Workload exceeded fixed 10-minute boundary")), 600_000);
      const finish = () => clearTimeout(timeout);
      instance.onmessage = event => {
        if (event.data.acknowledgement) { void global.vfsAck?.(event.data.acknowledgement); return; }
        finish(); if (event.data.error) reject(Object.assign(new Error(event.data.error.message), event.data.error)); else resolve(event.data.result);
      };
      instance.onerror = event => { finish(); reject(new Error(event.message)); };
      instance.onmessageerror = () => { finish(); reject(new Error("Cannot decode benchmark response")); };
      instance.postMessage(input);
    });
  }, request);
}
async function summarize(output: string, samples: Sample[], metadata: unknown, options: Options): Promise<void> {
  const baseline = samples.filter(s => s.role !== "candidate"), candidate = samples.filter(s => s.role === "candidate");
  if (candidate.length && (!options.initialBaseline || !options.acceptedSummary)) throw new Error("Candidate extraction requires immutable initial baseline and accepted summary inputs");
  const initial: Sample[] = options.initialBaseline ? await Bun.file(options.initialBaseline).json() : baseline;
  const acceptedBest = options.acceptedSummary ? Object.fromEntries(Object.entries((await Bun.file(options.acceptedSummary).json()).perVfs).flatMap(([name, value]) => { const score = (value as { score: number | null }).score; return score === null ? [] : [[name, score]]; })) : {};
  const summary = { metadata, ...score(initial, candidate.length ? candidate : baseline, candidate.length ? baseline : undefined, acceptedBest) };
  await Bun.write(resolve(output, "samples.json"), JSON.stringify(samples));
  await Bun.write(resolve(output, "summary.json"), JSON.stringify(summary, null, 2));
}
async function extract(options: Options): Promise<void> {
  if (await Bun.file(resolve(options.output, "samples.json")).exists()) throw new Error("Campaign output already exists; baselines are immutable");
  const lines = (await readFile(options.extract!, "utf8")).split("\n").filter(line => line.startsWith(PREFIX)).map(line => JSON.parse(line.slice(PREFIX.length)));
  const samples: Sample[] = lines.filter(line => line.kind === "sample").map(line => line.sample);
  const metadata = lines.find(line => line.kind === "metadata")?.metadata;
  if (!metadata || !lines.some(line => line.kind === "finished")) throw new Error("Incomplete campaign evidence; retain log, do not publish as completed");
  await mkdir(options.output, { recursive: true }); await summarize(options.output, samples, metadata, options);
  await Bun.write(resolve(options.output, "events.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
}
async function campaign(options: Options): Promise<void> {
  const manifestPath = process.env.TMPDIR ? resolve(process.env.TMPDIR, "../manifest.json") : undefined;
  const manifest = manifestPath && await Bun.file(manifestPath).exists() ? await Bun.file(manifestPath).json() : undefined;
  options.revision = sourceRevision(resolve(import.meta.dir, ".."), manifest);
  if (options.candidateRoot) options.candidateRevision = sourceRevision(options.candidateRoot);
  const continuation = options.continuationOf ? compareContinuation(resolve(import.meta.dir, ".."), options.continuationOf, options.revision) : undefined;
  const lifecycle = new BrowserRunnerLifecycle(3_500_000); const samples: Sample[] = [];
  const emit = (value: unknown) => console.log(PREFIX + JSON.stringify(value));
  await mkdir(options.output, { recursive: true });
  if (await Bun.file(resolve(options.output, "samples.json")).exists()) throw new Error("Campaign output already exists; baselines are immutable");
  const root = resolve(import.meta.dir, "..");
  const metadata = { protocol: SCORE_PROTOCOL, campaign: options.campaign, revision: options.revision, candidateRevision: options.candidateRevision, seed: FIXTURE_SEED, runner: hostname(), platform: process.platform, kernel: release(), cpu: cpus(), ram: totalmem(), bun: Bun.version, sampling: SAMPLING[options.mode], selections: { browsers: options.browsers, workloads: options.workloads, lanes: options.lanes, cells: options.cells ? Array.from(options.cells) : undefined }, continuation, intervals: { W1: "controller launch -> metadata ready; browser first stat/read; fixed 128 reads; new process/app cache, not cold device", W2: "first staging mkdir -> final global flush; fixed verification in trace; full final verification outside time", W3: "first 64KiB write -> last write; final file flush; new process -> sequential verified reads, hash comparison after clock", W4: "first 4KiB mutation -> final namespace barrier; includes per-save fsync", W5: "four real pages, same origin and workspace; exclusive ownership, not four-tab throughput" }, rss: "sampled process-tree RSS at 100ms (lower bound, shared mappings may be double-counted)", storage: "closed profile stat size and allocated blocks, not exact storage-device bytes", environmentRules: "CPU steal >1%, available RAM <512MiB, memory full PSI avg10 >1%; failures retained even under jitter", preexisting: await environment() };
  let rssPeak = 0, rssBusy = false;
  const rssTimer = setInterval(() => { if (!rssBusy) { rssBusy = true; void controllerRss().then(value => { rssPeak = Math.max(rssPeak, value); }).finally(() => { rssBusy = false; }); } }, 100);
  try {
    await lifecycle.init();
    const routes: Record<string, Blob | string> = { "/": "<!doctype html><title>Waffle VFS benchmark</title>" };
    const builds = new Map<string, { benchmark: Blob; fs: Blob }>();
    const compressedBytes: Record<string, unknown> = {};
    for (const role of options.candidateRoot ? ["baseline", "candidate"] : ["baseline"]) {
      const source = role === "candidate" ? options.candidateRoot! : root;
      if (role === "candidate") for (const name of ["vfs-workloads.ts", "vfs-score-config.ts", "vfs-guest.ts", "vfs-startup.ts", "vfs-browser.ts", "vfs-benchmark.ts", "vfs-continuation.ts"]) {
        if (await readFile(resolve(root, "tooling", name), "utf8") !== await readFile(resolve(source, "tooling", name), "utf8")) throw new Error(`Paired workload protocol differs: ${name}`);
      }
      if (role === "candidate" && await readFile(resolve(root, "tests/browser-runner-lifecycle.ts"), "utf8") !== await readFile(resolve(source, "tests/browser-runner-lifecycle.ts"), "utf8")) throw new Error("Paired lifecycle protocol differs");
      builds.set(role, { benchmark: await browserBundle(resolve(source, "tooling/vfs-browser.ts")), fs: await browserBundle(resolve(source, "browser/fs-worker.ts")) });
      const size = async (path: string) => { const blob = await browserBundle(resolve(source, path)); return { raw: blob.size, gzip: Bun.gzipSync(await blob.arrayBuffer()).byteLength }; };
      compressedBytes[role] = { sharedFacade: await size("browser/shared-fs.ts"), indexeddbStandalone: await size("fs/indexeddb.ts"), opfsStandalone: await size("fs/opfs.ts"), sharedWorker: await size("browser/fs-worker.ts"), interpretation: "standalone entry bundles including dependencies, not additive marginal backend contributions; current worker includes both persistent backends" };
    }
    const origin = lifecycle.serve(routes);
    Object.assign(metadata, { compressedBytes });
    emit({ kind: "metadata", metadata });
    const sampling = SAMPLING[options.mode];
    for (const browser of options.browsers) for (const backend of ["indexeddb", "opfs"] as const) {
      const vfs = backend === "opfs" ? "opfs-memory" : "indexeddb";
      // The Firefox VDO workaround is needed only on the PC, not the fixed ext4 runner.
      const profileRoot = process.env.VFS_FIREFOX_PROFILE_ROOT && browser === "firefox" ? process.env.VFS_FIREFOX_PROFILE_ROOT : lifecycle.scratch;
      for (const workload of options.workloads) for (const lane of options.lanes) {
        if (options.cells && !options.cells.has(`${browser}/${vfs}/${workload}/${lane}`)) continue;
        const templates = new Map<string, string>();
        for (let repetition = -sampling.warmups; repetition < sampling.repetitions; repetition++) {
          for (const role of options.candidateRoot ? pairOrder(Math.max(0, repetition)) : ["baseline"] as const) {
            const build = builds.get(role)!; routes["/benchmark.js"] = build.benchmark; routes["/fs-worker.js"] = build.fs;
            const revision = role === "candidate" ? options.candidateRevision! : options.revision;
            const sample: Sample = { protocol: SCORE_PROTOCOL, campaign: options.campaign, runner: hostname(), browser, browserVersion: "unavailable", vfs, workload, lane, repetition, warmup: repetition < 0, state: "eligible", metrics: {}, role, revision, ...(options.mode === "promotion" ? { pair: repetition } : {}) };
            const before = await environment(); rssPeak = 0;
            let profile = await lifecycle.directory(profileRoot, "vfs-"); let context: BrowserContext | undefined;
            const input: BrowserRequest = { action: "run", backend, workload, lane, name: "waffle-vfs-fixture" };
            const pageFor = async (active: BrowserContext) => {
              const page = await active.newPage(); await page.exposeBinding("vfsAck", (_source, value) => emit({ kind: "acknowledgement", cell: `${browser}/${vfs}/${workload}/${lane}`, repetition, role, value }));
              await page.goto(origin); return page;
            };
            try {
              if (workload === "W1") {
                let template = templates.get(role);
                if (!template) {
                  template = await lifecycle.directory(profileRoot, "vfs-seed-"); context = await lifecycle.persistent(browser, template);
                  const page = await pageFor(context);
                  await worker(page, { ...input, action: "seed" });
                  await lifecycle.closeContext(context); context = undefined; templates.set(role, template);
                  emit({ kind: "fixture", browser, backend, role, seedMethod: "production StorageBackend.persist + global flush + close, no resident facade seeding", profileBytes: await treeSize(template) });
                }
                // First-ever empty open has the same two warmups/five samples, in
                // its own new process/profile. Never reuse it as the seeded profile.
                const emptyStart = performance.now(); context = await lifecycle.persistent(browser, profile);
                const emptyPage = await pageFor(context);
                const empty = await worker(emptyPage, { ...input, action: "open", name: "waffle-vfs-empty" });
                sample.metrics.emptyOpenControllerMs = performance.now() - emptyStart;
                sample.metrics.emptyMetadataReadinessMs = empty.metrics.readinessMs!;
                sample.observations = { freshEmptyProfile: { profile: "fresh", database: "absent", startup: empty.observations.startupMilestones } };
                if (backend === "indexeddb") {
                  sample.metrics.freshIndexeddbOpenMs = empty.metrics.indexeddbOpenMs!;
                  sample.metrics.freshTreeReadyAfterIndexeddbMs = empty.metrics.treeReadyAfterIndexeddbMs!;
                }
                await worker(emptyPage, { ...input, action: "dispose", name: "waffle-vfs-empty" });
                await lifecycle.closeContext(context); context = undefined;
                if (backend === "indexeddb") {
                  // Delete only the empty diagnostic DB in its own process, then
                  // relaunch the preserved profile for a genuine first visit.
                  context = await lifecycle.persistent(browser, profile);
                  const deleting = await pageFor(context);
                  await worker(deleting, { ...input, action: "delete-empty", name: "waffle-vfs-empty" });
                  await lifecycle.closeContext(context); context = undefined;
                  const firstVisitStart = performance.now(); context = await lifecycle.persistent(browser, profile);
                  const firstVisitPage = await pageFor(context);
                  const firstVisit = await worker(firstVisitPage, { ...input, action: "open", name: "waffle-vfs-empty" });
                  sample.metrics.firstVisitOpenControllerMs = performance.now() - firstVisitStart;
                  sample.metrics.firstVisitIndexeddbOpenMs = firstVisit.metrics.indexeddbOpenMs!;
                  sample.metrics.firstVisitTreeReadyAfterIndexeddbMs = firstVisit.metrics.treeReadyAfterIndexeddbMs!;
                  sample.observations.firstVisitProfile = { profile: "existing", database: "deleted before process launch", startup: firstVisit.observations.startupMilestones };
                  await worker(firstVisitPage, { ...input, action: "dispose", name: "waffle-vfs-empty" });
                  await lifecycle.closeContext(context); context = undefined;
                }
                await lifecycle.removeDirectory(profile); profile = await lifecycle.directory(profileRoot, "vfs-");
                await cp(template, profile, { recursive: true });
              }
              const storageBefore = await treeSize(profile); sample.observations = { ...sample.observations, storageBefore };
              const launchStart = performance.now(); context = await lifecycle.persistent(browser, profile);
              sample.browserVersion = context.browser()?.version() ?? `${browser}-persistent`;
              const page = await pageFor(context);
              if (workload === "W5") {
                await worker(page, { ...input, action: "open" });
                await worker(page, { ...input, action: "marker" });
                const pages: Page[] = [page], handoffs: number[] = [], revocations: number[] = [], takeovers: number[] = [];
                const until = async (target: Page, status: string, lost = false) => {
                  await target.waitForFunction(async ({ input, status, lost }) => {
                    const g = globalThis as typeof globalThis & { benchmarkWorker?: Worker };
                    return new Promise<boolean>(resolve => {
                      g.benchmarkWorker!.onmessage = event => resolve(!event.data.error && (lost ? event.data.result?.ownershipLost === true : event.data.result?.status === status));
                      g.benchmarkWorker!.postMessage({ ...input, action: "ownership" });
                    });
                  }, { input, status, lost }, { timeout: 15000, polling: 20 });
                };
                // Real pages queue behind the same workspace owner. Observe each
                // waiting state before allowing the next contender to join the FIFO.
                for (let i = 0; i < 3; i++) {
                  const contender = await pageFor(context); pages.push(contender);
                  await worker(contender, { ...input, action: "start", whenBusy: "wait" });
                  await until(contender, "waiting");
                }
                for (let i = 1; i < pages.length; i++) {
                  const start = performance.now();
                  await worker(pages[i - 1]!, { ...input, action: "dispose" });
                  await worker(pages[i]!, { ...input, action: "open" });
                  handoffs.push(performance.now() - start);
                  await worker(pages[i]!, { ...input, action: "probe" });
                  for (let j = i + 1; j < pages.length; j++) {
                    const state = await worker(pages[j]!, { ...input, action: "ownership" });
                    if (state.status !== "waiting") throw new Error("Queued ownership did not preserve exclusive FIFO order");
                  }
                }
                await worker(pages[3]!, { ...input, action: "dispose" });
                // Separate IndexedDB default-takeover case, never presented as
                // simultaneous four-writer throughput or queued handoff latency.
                if (backend === "indexeddb") {
                  const takeover = { ...input, name: `${input.name}-takeover` };
                  await worker(pages[0]!, { ...takeover, action: "open" });
                  await worker(pages[0]!, { ...takeover, action: "marker" });
                  for (let i = 1; i < pages.length; i++) {
                    const start = performance.now();
                    const revoked = worker(pages[i - 1]!, { ...takeover, action: "await-revocation" }).then(() => performance.now() - start);
                    void revoked.catch(() => {}); // Observe even if contender startup fails.
                    await worker(pages[i]!, { ...takeover, action: "open" });
                    takeovers.push(performance.now() - start); revocations.push(await revoked);
                    const fenced = await worker(pages[i - 1]!, { ...takeover, action: "fence" });
                    if (fenced.observations.fenced !== true) throw new Error("Missing old-owner fencing assertion");
                    await worker(pages[i]!, { ...takeover, action: "probe" });
                    await worker(pages[i - 1]!, { ...takeover, action: "dispose" });
                  }
                  await worker(pages[3]!, { ...takeover, action: "dispose" });
                }
                const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
                sample.metrics = { handoffMs: mean(handoffs), ...(takeovers.length ? { takeoverMs: mean(takeovers), revocationMs: mean(revocations) } : {}) };
                sample.latencies = { handoff: handoffs, takeover: takeovers, revocation: revocations };
                sample.observations = { ...sample.observations, realPages: 4, origin, workspace: input.name, fifoAndMarkerVerified: true, oldOwnerFenced: backend === "indexeddb", concurrentThroughput: "not applicable to exclusive backends" };
              } else {
                const opened = await worker(page, { ...input, action: "open" });
                const launchToReadyMs = performance.now() - launchStart;
                if (workload === "W1") {
                  sample.observations!.seededReopenProfile = { profile: "existing, copied preserved seed profile", database: "existing seeded tree", startup: opened.observations.startupMilestones };
                  if (backend === "indexeddb") {
                    sample.metrics.indexeddbOpenMs = opened.metrics.indexeddbOpenMs!;
                    sample.metrics.treeReadyAfterIndexeddbMs = opened.metrics.treeReadyAfterIndexeddbMs!;
                  }
                }
                const result = await worker(page, input);
                sample.metrics = { ...sample.metrics, ...result.metrics, metadataReadinessMs: opened.metrics.readinessMs!, readinessMs: launchToReadyMs, launchToReadyMs }; sample.latencies = result.latencies; sample.acknowledgements = result.acknowledgements; sample.observations = { ...sample.observations, ...result.observations };
                sample.metrics.launchThroughWorkloadControllerMs = performance.now() - launchStart;
                await worker(page, { ...input, action: "dispose" });
              }
              await lifecycle.closeContext(context); context = undefined;
              const storage = await treeSize(profile); sample.metrics.profileLogicalBytes = storage.logical; sample.metrics.profileAllocatedBytes = storage.physical;
              if (storageBefore) { sample.metrics.profileLogicalGrowthBytes = storage.logical - storageBefore.logical; sample.metrics.profileAllocatedGrowthBytes = storage.physical - storageBefore.physical; }
              if (workload === "W3") {
                context = await lifecycle.persistent(browser, profile); const page = await pageFor(context);
                const read = await worker(page, { ...input, action: "read" }); Object.assign(sample.metrics, read.metrics, { readinessMs: sample.metrics.readinessMs, residentPayloadEndBytes: Math.max(sample.metrics.residentPayloadEndBytes ?? 0, read.metrics.residentPayloadEndBytes ?? 0) });
                await worker(page, { ...input, action: "dispose" }); await lifecycle.closeContext(context); context = undefined;
              }
            } catch (error) {
              const message = String(error); sample.reason = message;
              sample.state = /identity table exhausted|errno 51|errno 48|ENOSPC|QuotaExceeded/i.test(message) ? "deferred/not measured" : "failed correctness";
              sample.observations = { ...sample.observations, failure: message, capacityLimitIsNotAChangedFixture: true };
            } finally {
              if (context) await lifecycle.closeContext(context);
              await lifecycle.removeDirectory(profile);
            }
            sample.metrics.sampledProcessTreePeakRssBytes = rssPeak;
            const after = await environment(); const noise = invalidReason(before, after);
            sample.observations = { ...sample.observations, environment: { before, after }, ...(noise ? { environmentalInvalidity: noise } : {}) };
            // Jitter never erases correctness failures.
            if (noise && sample.state === "eligible") { sample.state = "invalid environment"; sample.reason = noise; }
            samples.push(sample); emit({ kind: "sample", sample });
            await Bun.write(resolve(options.output, "samples.json"), JSON.stringify(samples));
          }
        }
        for (const template of templates.values()) await lifecycle.removeDirectory(template);
      }
    }
    await summarize(options.output, samples, metadata, options);
    emit({ kind: "finished", samples: samples.length, eligible: samples.filter(s => s.state === "eligible" && !s.warmup).length });
  } finally { clearInterval(rssTimer); await lifecycle.close(); }
}
if (import.meta.main) { const options = argumentsFor(process.argv.slice(2)); if (options.extract) await extract(options); else await campaign(options); }
