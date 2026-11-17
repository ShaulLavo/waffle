import { MemoryGroups, type MemberLease, type MemoryGroupOwner } from "../group/state.ts";
import { GroupOp, PAGE_BYTES } from "../group/protocol.ts";
import { runningMemberModule } from "./fixtures/running-member-wasm.ts";
import type { RunningMemberRequest } from "./fixtures/running-member-worker.ts";

/**
 * When the owner returns a terminated member's chunks, relative to `worker.terminate()`:
 * `sync` is tighter than production, `microtask` matches the broker's
 * terminateWorker -> await -> stopped() path, and `task` waits one macrotask.
 */
type ReleaseTiming = "sync" | "microtask" | "task";
const timings: readonly ReleaseTiming[] = ["sync", "microtask", "task"];

export interface RunningMemberOptions {
  readonly repetitions: number;
  /** Chunk size of the busy member and of the keeper's reusing grow. */
  readonly pages: number;
  /** Tight scan of the reused chunk right after the owner's zero-fill. */
  readonly scanMs: number;
  /** The terminated thread counts as stopped once its heartbeat is unchanged this long. */
  readonly quietMs: number;
  /** How long to watch one terminated thread before recording it as still running. */
  readonly stopCapMs: number;
  /** Extra delay between stopRequested() and stopped(), for the quarantine measurement. */
  readonly holdMs?: number;
  /** Worker holds this Web Lock while it runs; the page records when it is granted again. */
  readonly lock?: boolean;
}

interface Repetition {
  readonly timing: ReleaseTiming;
  readonly releasedAfterMs: number;
  /** First non-zero word in the reused chunk after its zero-fill, ms after terminate(). */
  readonly hitAtMs?: number;
  /** The chunk holds this repetition's own marker: the write came from this member. */
  readonly ownMarker: boolean;
  /** Last heartbeat change seen after terminate(), polled without blocking the page. */
  readonly lastWriteMs: number;
  /** Still writing when the stop cap ran out. */
  readonly running: boolean;
  /** Web Lock granted to the page again, ms after terminate(); absent if not by the cap. */
  readonly lockGrantedMs?: number;
  /** The heartbeat still moved after the page was granted the worker's lock. */
  readonly writesAfterLock: boolean;
}

const WORDS_PER_PAGE = PAGE_BYTES / 4;
const now = () => performance.now();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function nonZero(view: Int32Array): boolean {
  for (let index = 0; index < view.length; index++) if (view[index] !== 0) return true;
  return false;
}

/** Tight synchronous scan, as a sibling that starts using its new pages at once would see. */
function scan(view: Int32Array, start: number, ms: number): number | undefined {
  const until = now() + ms;
  while (now() < until) if (nonZero(view)) return now() - start;
  return undefined;
}

/** Polls the heartbeat while yielding to the event loop, so termination is never starved. */
async function lastWrite(beat: Int32Array, start: number, quietMs: number, capMs: number) {
  const until = now() + capMs;
  let last = Atomics.load(beat, 0),
    changedAt = now(),
    lastWriteMs = 0;
  while (now() - changedAt < quietMs) {
    if (now() > until) return { lastWriteMs, running: true };
    await pause(1);
    const value = Atomics.load(beat, 0);
    if (value === last) continue;
    last = value;
    changedAt = now();
    lastWriteMs = changedAt - start;
  }
  return { lastWriteMs, running: false };
}

async function releaseAfter(timing: ReleaseTiming, holdMs: number): Promise<void> {
  if (timing === "microtask") for (let step = 0; step < 4; step++) await Promise.resolve();
  if (timing === "task") await pause(0);
  if (holdMs) await pause(holdMs);
}

function grow(owner: MemoryGroupOwner, lease: MemberLease, pages: number): number {
  const [page] = owner.request(lease, GroupOp.GROW, pages);
  if (page === undefined || page <= 0) throw new Error(`group grow failed: ${page}`);
  return page;
}

function startBusy(request: RunningMemberRequest): { worker: Worker; running: Promise<void> } {
  const worker = new Worker("/worker.js", { type: "module" });
  const running = new Promise<void>((resolve, reject) => {
    worker.onmessage = ({ data }) =>
      data.event === "running" ? resolve() : reject(new Error(String(data.event)));
    worker.onerror = (event) => reject(new Error(event.message));
  });
  worker.postMessage(request);
  return { worker, running };
}

/** Busy-waits until the guest's heartbeat moved twice: it is executing its loop, not booting. */
function awaitBeats(beat: Int32Array): void {
  const until = now() + 10_000;
  while (Atomics.load(beat, 0) < 2)
    if (now() > until) throw new Error("timed out waiting for the busy member's heartbeat");
}

/**
 * Resolves with the grant time and the heartbeat at grant, or undefined if the lock is still
 * held when `cap` settles.
 */
function lockGranted(name: string, start: number, beat: Int32Array, cap: Promise<unknown>) {
  const abort = new AbortController();
  void cap.then(() => abort.abort());
  return navigator.locks
    .request(name, { signal: abort.signal }, async () => ({
      ms: now() - start,
      beat: Atomics.load(beat, 0),
    }))
    .catch(() => undefined);
}

/**
 * One group per repetition: an anchor keeps it alive, a busy member spins on its chunk, and a
 * keeper grows into that chunk once the owner returned it. A terminated thread that never
 * stops keeps writing only into its own repetition's memory.
 */
class Repeat {
  private readonly groups: MemoryGroups;
  private readonly anchor: MemberLease;
  private readonly owner: MemoryGroupOwner;
  readonly memory: WebAssembly.Memory;
  private pid = 2;

  constructor(pages: number) {
    // WebKit reserves the declared maximum up front, so keep it small.
    this.groups = new MemoryGroups({ maximumPages: 1 + pages, members: 3 });
    this.anchor = this.groups.admit(1, "running-member", "new");
    const launched = this.anchor.launch();
    launched.request.port.close();
    this.memory = launched.request.memory;
    this.owner = this.groups.owner(this.anchor.group)!;
  }

  admit(): { lease: MemberLease; grow(pages: number): number; close(): void } {
    const lease = this.groups.admit(this.pid++, "running-member", this.anchor.group);
    const { request } = lease.launch();
    return {
      lease,
      grow: (pages) => grow(this.owner, lease, pages),
      close() {
        request.port.close();
        lease.stopRequested();
        lease.stopped();
      },
    };
  }

  end(): void {
    this.anchor.stopRequested();
    this.anchor.stopped();
    if (this.groups.snapshot().length) throw new Error("memory group still live after its run");
  }
}

async function repetition(
  module: WebAssembly.Module,
  options: RunningMemberOptions,
  index: number,
): Promise<Repetition> {
  const { pages, scanMs, quietMs, stopCapMs, holdMs = 0 } = options;
  const timing = timings[index % timings.length]!;
  const marker = (0x5a000000 | index) >>> 0;
  const lock = options.lock ? `waffle-running-member-${crypto.randomUUID()}` : undefined;
  const group = new Repeat(pages);
  const busy = group.admit(),
    keeper = group.admit();
  let worker: Worker | undefined;
  try {
    const page = busy.grow(pages);
    const beat = new Int32Array(group.memory.buffer, page * PAGE_BYTES, 1);
    const started = startBusy({
      module,
      memory: group.memory,
      base: page * PAGE_BYTES,
      words: pages * WORDS_PER_PAGE,
      marker,
      lock,
    });
    worker = started.worker;
    await started.running;
    awaitBeats(beat);
    // Vary where in its loop the guest is when terminate() lands.
    const offset = now() + (index % 7) * 0.13;
    while (now() < offset);
    const start = now();
    worker.terminate();
    busy.lease.stopRequested();
    const watched = Promise.withResolvers<void>();
    const granted = lock ? lockGranted(lock, start, beat, watched.promise) : undefined;
    await releaseAfter(timing, holdMs);
    busy.lease.stopped();
    const releasedAfterMs = now() - start;
    const reused = keeper.grow(pages);
    if (reused !== page) throw new Error(`keeper took page ${reused}, not ${page}`);
    const view = new Int32Array(group.memory.buffer, page * PAGE_BYTES, pages * WORDS_PER_PAGE);
    const hitAtMs = scan(view, start, scanMs);
    const write = await lastWrite(beat, start, quietMs, stopCapMs);
    watched.resolve();
    const lockAt = await granted;
    return {
      timing,
      releasedAfterMs,
      hitAtMs: hitAtMs ?? (nonZero(view) ? write.lastWriteMs : undefined),
      ownMarker: view.includes(marker | 0),
      ...write,
      lockGrantedMs: lockAt?.ms,
      writesAfterLock: !!lockAt && Atomics.load(beat, 0) !== lockAt.beat,
    };
  } finally {
    worker?.terminate();
    busy.close();
    keeper.close();
    group.end();
  }
}

const maximum = (values: readonly number[]) => Math.max(0, ...values);
function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
const round = (value: number) => Math.round(value * 100) / 100;
const spread = (values: readonly number[]) => ({
  median: round(median(values)),
  max: round(maximum(values)),
});

function summarize(results: readonly Repetition[]) {
  const byTiming = Object.fromEntries(
    timings.map((timing) => {
      const runs = results.filter((result) => result.timing === timing);
      return [
        timing,
        {
          runs: runs.length,
          hits: runs.filter((result) => result.hitAtMs !== undefined).length,
          maxReleasedAfterMs: round(maximum(runs.map((result) => result.releasedAfterMs))),
        },
      ];
    }),
  );
  const hits = results.flatMap((result) => (result.hitAtMs === undefined ? [] : [result.hitAtMs]));
  const stopped = results.filter((result) => !result.running);
  const locks = results.flatMap((result) =>
    result.lockGrantedMs === undefined ? [] : [result.lockGrantedMs],
  );
  return {
    runs: results.length,
    hits: hits.length,
    /** Hits whose chunk also held the member's own marker word. */
    attributed: results.filter((result) => result.hitAtMs !== undefined && result.ownMarker).length,
    byTiming,
    hitAtMs: spread(hits),
    /** Terminated threads still writing when the stop cap ran out. */
    stillRunningAtCap: results.length - stopped.length,
    lastWriteAfterTerminateMs: spread(stopped.map((result) => result.lastWriteMs)),
    locksGranted: locks.length,
    writesAfterLock: results.filter((result) => result.writesAfterLock).length,
    lockGrantedAfterTerminateMs: spread(locks),
  };
}

/**
 * @browserEntry Measurement for the Web Lock design option: how long a terminated member
 * parked in an untimed wait keeps the lock it took before guest code. Returns only scalars.
 */
export async function sleeperLockHold(repetitions: number, capMs: number) {
  const module = new WebAssembly.Module(runningMemberModule());
  const granted: number[] = [];
  for (let index = 0; index < repetitions; index++) {
    const group = new Repeat(1);
    const sleeper = group.admit();
    const name = `waffle-sleeping-member-${crypto.randomUUID()}`;
    const page = sleeper.grow(1);
    const started = startBusy({
      module,
      memory: group.memory,
      base: page * PAGE_BYTES,
      words: WORDS_PER_PAGE,
      marker: 0,
      lock: name,
      sleep: true,
    });
    try {
      await started.running;
      // The running message precedes Atomics.wait; give the thread time to park.
      await pause(20);
      const start = now();
      started.worker.terminate();
      const cap = pause(capMs);
      const at = await lockGranted(name, start, new Int32Array(1), cap);
      if (at) granted.push(at.ms);
    } finally {
      sleeper.close();
      group.end();
    }
  }
  return { runs: repetitions, granted: granted.length, grantedAfterMs: spread(granted), capMs };
}

/**
 * @browserEntry Terminates a member while its guest spins in a pure Wasm loop on group
 * memory, returns its chunk, and has a live sibling grow into that chunk at once. The owner
 * zero-fills the chunk on reuse, so any non-zero word seen afterwards was written by the
 * terminated member after its pages changed hands. Returns only scalars.
 */
export async function runningMemberReuse(options: RunningMemberOptions) {
  const module = new WebAssembly.Module(runningMemberModule());
  const results: Repetition[] = [];
  for (let index = 0; index < options.repetitions; index++)
    results.push(await repetition(module, options, index));
  return {
    pages: options.pages,
    holdMs: options.holdMs ?? 0,
    lock: !!options.lock,
    ...summarize(results),
  };
}
