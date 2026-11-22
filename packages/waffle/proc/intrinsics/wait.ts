/* A blocking wait that lets WebKit finish an open garbage collection.
 *
 * A WebKit Worker parked in Atomics.wait keeps heap access. A collection cycle that is open in
 * its VM then stays open until the Worker runs again, and it keeps the process-wide marking
 * helper threads parked in that cycle. A collection in another Worker gets no helper, and a
 * synchronous one never returns: WebKit runs one inside `new WebAssembly.Instance` when the
 * process already holds its limit of fast Wasm memories, so a process start can stop there for
 * good. See docs/webkit-blocking-waits.md.
 *
 * The cooperative wait wakes the first seconds of a sleep at growing intervals and allocates a
 * little. The allocation reaches the engine's allocation slow path, where the mutator finishes
 * the cycle it was handed. After the last wake the Worker allocates nothing, so no new cycle can
 * open, and the rest of the sleep is one native wait.
 *
 * Between two slices the Worker is briefly off the wait queue. A notify in that gap is seen only
 * through the changed value, so this wait is for words whose producers publish a change before
 * they notify. A futex that a guest may wake without changing the word uses the native wait.
 */

type Wait = typeof Atomics.wait;
type WaitResult = ReturnType<Wait>;

/** A sleep first wakes after this long, then at doubling intervals. */
export const FIRST_WAKE_MS = 16;
/** The last interval. A sleep stops waking after about twice this long in total. */
export const LAST_WAKE_MS = 2048;
/** Running this long between two waits may have opened a new cycle, so the schedule restarts. */
const ACTIVITY_MS = 1;
/** Enough small cells to cross a block boundary, which is where the engine polls. */
const YOUNG_CELLS = 1024;

const mathMin = Math.min;

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

/** The timeout in milliseconds as Atomics.wait reads a number, or undefined for anything else. */
function plainLimit(timeout: unknown): number | undefined {
  if (timeout === undefined) return Infinity;
  if (typeof timeout !== "number") return undefined;
  if (timeout !== timeout) return Infinity;
  return timeout > 0 ? timeout : 0;
}

/**
 * Wraps a native Atomics.wait. A call whose arguments the native wait would convert through
 * guest code, and a call that does not wait at all, goes straight to it. Otherwise results and
 * timeouts match the native call, except that a notify which arrives in the gap between two
 * slices returns "not-equal" when the value changed and is missed when it did not.
 */
export function createCooperativeWait(
  native: Wait,
  clock: () => number,
  allocate: () => void = allocateYoung,
): Wait {
  const call = native as (...args: unknown[]) => WaitResult;
  let interval = FIRST_WAKE_MS;
  let nextWake = Infinity;
  let lastReturn = -Infinity;
  const wait = (array: unknown, index: unknown, value: unknown, timeout?: unknown): WaitResult => {
    const limit = plainLimit(timeout);
    const plain =
      typeof index === "number" && (typeof value === "number" || typeof value === "bigint");
    if (!plain || limit === undefined || limit === 0) return call(array, index, value, timeout);
    let now = clock();
    if (now - lastReturn > ACTIVITY_MS) {
      interval = FIRST_WAKE_MS;
      nextWake = now + FIRST_WAKE_MS;
    }
    const deadline = now + limit;
    for (;;) {
      const result = call(array, index, value, mathMin(deadline, nextWake) - now);
      now = clock();
      if (result !== "timed-out" || now >= deadline) {
        lastReturn = now;
        return result;
      }
      if (now < nextWake) continue;
      allocate();
      interval *= 2;
      now = clock();
      nextWake = interval > LAST_WAKE_MS ? Infinity : now + interval;
      if (now < deadline) continue;
      lastReturn = now;
      return "timed-out";
    }
  };
  return wait as Wait;
}

/** WebKit in any shell: Safari, every iOS browser, and the WPE and GTK ports. */
export function needsCooperativeWait(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /AppleWebKit\//.test(userAgent) && !/Chrom(e|ium)\//.test(userAgent);
}

/** The engine's own wait, for a futex whose waker may leave the word unchanged. */
export const atomicsWaitNative: Wait = Atomics.wait;

const cooperative = needsCooperativeWait(globalThis.navigator?.userAgent);

/** The wait for every sleep on a word whose producers publish a change before they notify. */
export const atomicsWait: Wait = cooperative
  ? createCooperativeWait(
      atomicsWaitNative,
      globalThis.performance.now.bind(globalThis.performance),
    )
  : atomicsWaitNative;

/**
 * Makes the realm's own `Atomics.wait` cooperative, for guest JavaScript that sleeps in a
 * process Worker. Idempotent, and a no-op where the native wait is already safe.
 */
export function installCooperativeWait(): void {
  if (cooperative && Atomics.wait !== atomicsWait) Atomics.wait = atomicsWait;
}
