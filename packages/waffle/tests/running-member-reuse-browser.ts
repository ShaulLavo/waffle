import { MemoryGroups, type MemberLease, type MemoryGroupOwner } from "../group/state.ts";
import {
  GroupOp,
  PAGE_BYTES,
  WAIT_EPOCH,
  type MemoryGroupMemberRequest,
} from "../group/protocol.ts";
import { runningMemberModule } from "./fixtures/running-member-wasm.ts";
import type { RunningMemberRequest } from "./fixtures/running-member-worker.ts";

/**
 * When the owner releases a terminated member, relative to `worker.terminate()`: `sync` is
 * tighter than production, `microtask` is close to the broker's terminateWorker -> await ->
 * stopped() path (a few microtasks), and `task` waits one macrotask.
 */
type ReleaseTiming = "sync" | "microtask" | "task";
const timings: readonly ReleaseTiming[] = ["sync", "microtask", "task"];

export interface RunningMemberOptions {
  readonly repetitions: number;
  /** Chunk size of the terminated member and of each keeper grow. */
  readonly pages: number;
  /** Tight scan of the reused chunk right after the owner's zero-fill. */
  readonly scanMs: number;
  /** The terminated thread counts as still running if its heartbeat moves within this long. */
  readonly quietMs: number;
  /** Hang cap while waiting for the owner to prove a busy member's exit. */
  readonly proofCapMs: number;
  /**
   * The guest calls a checkpoint each pass and returns once it reports a stop, which the
   * page sets right before terminate(), as the broker selects SIGKILL first.
   */
  readonly polling?: boolean;
}

interface BusyRepetition {
  readonly timing: ReleaseTiming;
  /** The keeper got the terminated member's chunk before its exit was proven. */
  readonly reusedBeforeProof: boolean;
  /** The owner reported the chunk as quarantined right after release. */
  readonly quarantined: boolean;
  /** Owner proved exit (acquired the exit lock), ms after terminate(); absent by the cap. */
  readonly provenMs?: number;
  /** After proof the keeper got the chunk back. */
  readonly reusedAfterProof: boolean;
  /** First non-zero word in the reused chunk after its zero-fill, ms after terminate(). */
  readonly hitAtMs?: number;
  /** The heartbeat still moved at the end of the repetition. */
  readonly running: boolean;
}

interface ParkedRepetition {
  readonly timing: ReleaseTiming;
  /** The keeper got the parked member's chunk at once, with no exit proof. */
  readonly reusedAtOnce: boolean;
  readonly hitAtMs?: number;
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

/** Scans tightly, then once more after the guest had `quietMs` of page idle time to write. */
async function reusedHit(view: Int32Array, start: number, options: RunningMemberOptions) {
  const hit = scan(view, start, options.scanMs);
  if (hit !== undefined) return hit;
  await pause(options.quietMs);
  return nonZero(view) ? now() - start : undefined;
}

async function releaseAfter(timing: ReleaseTiming): Promise<void> {
  if (timing === "microtask") for (let step = 0; step < 4; step++) await Promise.resolve();
  if (timing === "task") await pause(0);
}

function tryGrow(owner: MemoryGroupOwner, lease: MemberLease, pages: number): number {
  return owner.request(lease, GroupOp.GROW, pages)[0] ?? -1;
}

function grow(owner: MemoryGroupOwner, lease: MemberLease, pages: number): number {
  const page = tryGrow(owner, lease, pages);
  if (page <= 0) throw new Error(`group grow failed: ${page}`);
  return page;
}

function startWorker(request: RunningMemberRequest, transfer: Transferable[] = []) {
  const worker = new Worker("/worker.js", { type: "module" });
  const running = new Promise<void>((resolve, reject) => {
    worker.onmessage = ({ data }) =>
      data.event === "running" ? resolve() : reject(new Error(String(data.event)));
    worker.onerror = (event) => reject(new Error(event.message));
  });
  worker.postMessage(request, transfer);
  return { worker, running };
}

/** Busy-waits until the guest's heartbeat moved twice: it is executing its loop, not booting. */
function awaitBeats(beat: Int32Array): void {
  const until = now() + 10_000;
  while (Atomics.load(beat, 0) < 2)
    if (now() > until) throw new Error("timed out waiting for the busy member's heartbeat");
}

/** Yields until the member published its futex wait record (odd epoch). */
async function awaitParked(reply: SharedArrayBuffer): Promise<void> {
  const cells = new Int32Array(reply);
  const until = now() + 10_000;
  while ((Atomics.load(cells, WAIT_EPOCH) & 1) === 0) {
    if (now() > until) throw new Error("timed out waiting for the member to park");
    await pause(1);
  }
  // The record is published just before the native wait; let the thread enter it.
  await pause(20);
}

/**
 * One group per repetition: an anchor keeps it alive, the terminated member works on its
 * chunk, and a keeper grows. The group has room for one spare chunk, so a correct owner can
 * serve the keeper without reusing the terminated member's chunk.
 */
class Repeat {
  private readonly groups: MemoryGroups;
  private readonly anchor: MemberLease;
  readonly owner: MemoryGroupOwner;
  readonly memory: WebAssembly.Memory;
  private pid = 2;

  constructor(pages: number) {
    // WebKit reserves the declared maximum up front, so keep it small.
    this.groups = new MemoryGroups({ maximumPages: 1 + 2 * pages, members: 3 });
    this.anchor = this.groups.admit(1, "running-member", "new");
    const launched = this.anchor.launch();
    launched.request.port.close();
    this.memory = launched.request.memory;
    this.owner = this.groups.owner(this.anchor.group)!;
  }

  admit() {
    const lease = this.groups.admit(this.pid++, "running-member", this.anchor.group);
    const { request, transfer } = lease.launch();
    let sent = false;
    return {
      lease,
      request,
      /** Hands the request port to a worker; the page then must not close it. */
      send(): { request: MemoryGroupMemberRequest; transfer: Transferable[] } {
        sent = true;
        return { request, transfer };
      },
      grow: (pages: number) => grow(this.owner, lease, pages),
      close() {
        if (!sent) request.port.close();
        lease.stopRequested();
        lease.stopped();
      },
    };
  }

  exiting() {
    const { exiting, quarantinedBytes } = this.owner.snapshot();
    return { exiting, quarantinedBytes };
  }

  /** Yields until the owner reports no unproven exit, or the cap runs out. */
  async proven(start: number, capMs: number): Promise<number | undefined> {
    while (this.exiting().exiting) {
      if (now() - start > capMs) return undefined;
      await pause(1);
    }
    return now() - start;
  }

  end(): void {
    this.anchor.stopRequested();
    this.anchor.stopped();
    if (this.groups.snapshot().length) throw new Error("memory group still live after its run");
  }
}

function exitLockOf(request: MemoryGroupMemberRequest): string {
  if (request.exitLock === undefined) throw new Error("the owner issued no exit lock");
  return request.exitLock;
}

/** Vary where in its loop the guest is when terminate() lands. */
function stagger(index: number): void {
  const offset = now() + (index % 7) * 0.13;
  while (now() < offset);
}

async function busyRepetition(
  module: WebAssembly.Module,
  options: RunningMemberOptions,
  index: number,
): Promise<BusyRepetition> {
  const { pages } = options;
  const timing = timings[index % timings.length]!;
  const group = new Repeat(pages);
  const busy = group.admit(),
    keeper = group.admit();
  let worker: Worker | undefined;
  try {
    const page = busy.grow(pages);
    const beat = new Int32Array(group.memory.buffer, page * PAGE_BYTES, 1);
    const interrupt = options.polling ? new SharedArrayBuffer(4) : undefined;
    const started = startWorker({
      module,
      memory: group.memory,
      base: page * PAGE_BYTES,
      words: pages * WORDS_PER_PAGE,
      marker: (0x5a000000 | index) >>> 0,
      lock: exitLockOf(busy.request),
      interrupt,
    });
    worker = started.worker;
    await started.running;
    awaitBeats(beat);
    stagger(index);
    const start = now();
    if (interrupt) Atomics.store(new Int32Array(interrupt), 0, 9);
    worker.terminate();
    busy.lease.stopRequested();
    await releaseAfter(timing);
    busy.lease.stopped();
    // A sibling growing at once is the tightest reuse window.
    const early = keeper.grow(pages);
    const held = group.exiting();
    const provenMs = await group.proven(start, options.proofCapMs);
    const late = tryGrow(group.owner, keeper.lease, pages);
    const view = new Int32Array(group.memory.buffer, page * PAGE_BYTES, pages * WORDS_PER_PAGE);
    const hitAtMs =
      early === page || late === page ? await reusedHit(view, start, options) : undefined;
    const before = Atomics.load(beat, 0);
    await pause(options.quietMs);
    return {
      timing,
      reusedBeforeProof: early === page || (provenMs === undefined && late === page),
      quarantined: held.exiting === 1 && held.quarantinedBytes === pages * PAGE_BYTES,
      provenMs,
      reusedAfterProof: provenMs !== undefined && late === page,
      hitAtMs,
      running: late !== page && Atomics.load(beat, 0) !== before,
    };
  } finally {
    worker?.terminate();
    busy.close();
    keeper.close();
    group.end();
  }
}

async function parkedRepetition(
  options: RunningMemberOptions,
  index: number,
): Promise<ParkedRepetition> {
  const { pages } = options;
  const timing = timings[index % timings.length]!;
  const group = new Repeat(pages);
  const sleeper = group.admit(),
    keeper = group.admit();
  let worker: Worker | undefined;
  try {
    const page = sleeper.grow(pages);
    const { request, transfer } = sleeper.send();
    const started = startWorker(
      {
        memory: group.memory,
        base: page * PAGE_BYTES,
        words: pages * WORDS_PER_PAGE,
        marker: 0,
        lock: exitLockOf(request),
        member: request,
      },
      transfer,
    );
    worker = started.worker;
    await started.running;
    await awaitParked(request.reply);
    const start = now();
    worker.terminate();
    sleeper.lease.stopRequested();
    await releaseAfter(timing);
    sleeper.lease.stopped();
    const reused = keeper.grow(pages);
    const view = new Int32Array(group.memory.buffer, page * PAGE_BYTES, pages * WORDS_PER_PAGE);
    return {
      timing,
      reusedAtOnce: reused === page && group.exiting().exiting === 0,
      hitAtMs: reused === page ? await reusedHit(view, start, options) : undefined,
    };
  } finally {
    worker?.terminate();
    sleeper.close();
    keeper.close();
    group.end();
  }
}

const round = (value: number) => Math.round(value * 100) / 100;
function spread(values: readonly number[]) {
  if (!values.length) return { median: 0, max: 0 };
  const sorted = values.toSorted((a, b) => a - b);
  return { median: round(sorted[Math.floor(sorted.length / 2)]!), max: round(sorted.at(-1)!) };
}
const count = <T>(results: readonly T[], test: (result: T) => boolean) =>
  results.filter(test).length;

/**
 * @browserEntry A member terminated while its guest spins in a pure Wasm loop (no host
 * calls) on group memory must not have its chunk handed to a live sibling until the owner
 * holds its exit lock. The owner zero-fills a reused chunk, so any non-zero word seen after
 * reuse was written by the terminated member. Returns only scalars.
 */
export async function runningMemberReuse(options: RunningMemberOptions) {
  const module = new WebAssembly.Module(runningMemberModule(options.polling));
  const results: BusyRepetition[] = [];
  for (let index = 0; index < options.repetitions; index++)
    results.push(await busyRepetition(module, options, index));
  const proven = results.flatMap((result) =>
    result.provenMs === undefined ? [] : [result.provenMs],
  );
  return {
    pages: options.pages,
    polling: !!options.polling,
    runs: results.length,
    reusedBeforeProof: count(results, (result) => result.reusedBeforeProof),
    notQuarantined: count(results, (result) => !result.quarantined),
    hits: count(results, (result) => result.hitAtMs !== undefined),
    proven: proven.length,
    reusedAfterProof: count(results, (result) => result.reusedAfterProof),
    provenAfterTerminateMs: spread(proven),
    /** Unproven members still writing their own quarantined chunk at the end. */
    stillRunning: count(results, (result) => result.running),
  };
}

/**
 * @browserEntry A member terminated while parked in the group's futex_wait32 has a closed
 * wait record, so the owner reuses its chunk at once without an exit proof. iOS Safari keeps
 * such a thread and its Web Lock alive, so gating it on the lock would strand its pages.
 */
export async function parkedMemberReuse(options: RunningMemberOptions) {
  const results: ParkedRepetition[] = [];
  for (let index = 0; index < options.repetitions; index++)
    results.push(await parkedRepetition(options, index));
  return {
    pages: options.pages,
    runs: results.length,
    reusedAtOnce: count(results, (result) => result.reusedAtOnce),
    hits: count(results, (result) => result.hitAtMs !== undefined),
  };
}
