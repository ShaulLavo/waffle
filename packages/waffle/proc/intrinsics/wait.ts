/* A blocking wait that lets WebKit finish an open garbage collection.
 *
 * A WebKit Worker parked in Atomics.wait keeps heap access. A collection cycle that is open in
 * its VM then stays open until the Worker runs again, and it keeps the process-wide marking
 * helper threads parked in that cycle. A collection in another Worker gets no helper, and a
 * synchronous one never returns: WebKit runs one inside `new WebAssembly.Instance` when the
 * process already holds its limit of fast Wasm memories, so a process start can stop there for
 * good. See docs/webkit-blocking-waits.md.
 *
 * The cooperative wait wakes a long wait at growing intervals and allocates a little. The
 * allocation reaches the engine's allocation slow path, where the mutator finishes the cycle it
 * was handed. A wait that is notified before the first interval pays two clock reads.
 */

type Wait = typeof Atomics.wait;
type WaitResult = ReturnType<Wait>;

/** A long wait first wakes after this long, then at doubling intervals. */
export const FIRST_WAKE_MS = 16;
/** The longest a sleeping Worker goes without giving the collector a turn. */
export const LONGEST_WAKE_MS = 2048;
/** Running this long between two waits may have opened a new cycle, so the schedule restarts. */
const ACTIVITY_MS = 1;
/** Enough small cells to cross a block boundary, which is where the engine polls. */
const YOUNG_CELLS = 1024;

const mathMin = Math.min;
const mathMax = Math.max;

let young: unknown;
/** Fresh cells that stay reachable until the next call, so the engine cannot skip allocating them. */
function allocateYoung(): void {
  let chain: unknown = null;
  for (let index = 0; index < YOUNG_CELLS; index++) chain = { next: chain };
  young = chain;
}

/** The last cells allocated for the collector. Tests read it to see that a wake allocated. */
export function youngCells(): unknown {
  return young;
}

function waitLimit(timeout: number | undefined): number {
  const limit = timeout === undefined ? Infinity : +timeout;
  if (limit !== limit) return Infinity;
  return mathMax(limit, 0);
}

/**
 * Wraps a native Atomics.wait. Results and timeouts match the native call, with two exceptions
 * that a caller of a futex-style wait already handles: a notify that arrives during a wake
 * returns "not-equal" when the value changed, and is missed when it did not.
 */
export function createCooperativeWait(
  native: Wait,
  clock: () => number,
  allocate: () => void = allocateYoung,
): Wait {
  let interval = FIRST_WAKE_MS;
  let nextWake = 0;
  let lastReturn = -Infinity;
  const wait = (
    array: Int32Array | BigInt64Array,
    index: number,
    value: number | bigint,
    timeout?: number,
  ): WaitResult => {
    const limit = waitLimit(timeout);
    const start = clock();
    if (start - lastReturn > ACTIVITY_MS) {
      interval = FIRST_WAKE_MS;
      nextWake = start + FIRST_WAKE_MS;
    }
    const deadline = start + limit;
    for (;;) {
      const slice = mathMax(0, mathMin(deadline, nextWake) - clock());
      const result = (native as (...args: unknown[]) => WaitResult)(array, index, value, slice);
      const after = clock();
      if (result !== "timed-out" || after >= deadline) {
        lastReturn = after;
        return result;
      }
      if (after < nextWake) continue;
      allocate();
      interval = mathMin(interval * 2, LONGEST_WAKE_MS);
      nextWake = clock() + interval;
    }
  };
  return wait as Wait;
}

/** WebKit in any shell: Safari, every iOS browser, and the WPE and GTK ports. */
export function needsCooperativeWait(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /AppleWebKit\//.test(userAgent) && !/Chrom(e|ium)\//.test(userAgent);
}

const nativeWait = Atomics.wait;
const performanceNow = globalThis.performance.now.bind(globalThis.performance);

/** Whether this realm's blocking waits are cooperative. */
const cooperativeWaits = needsCooperativeWait(globalThis.navigator?.userAgent);

/** The blocking wait every Waffle sleep goes through. */
export const atomicsWait: Wait = cooperativeWaits
  ? createCooperativeWait(nativeWait, performanceNow)
  : nativeWait;

/**
 * Makes the realm's own `Atomics.wait` cooperative, for guest JavaScript that sleeps in a
 * process Worker. Idempotent, and a no-op where the native wait is already safe.
 */
export function installCooperativeWait(): void {
  if (cooperativeWaits && Atomics.wait !== atomicsWait) Atomics.wait = atomicsWait;
}
