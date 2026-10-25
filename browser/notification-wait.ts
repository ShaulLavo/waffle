import { atomicsLoad, atomicsNotify, atomicsWait } from "../proc/intrinsics.js";

export type CoveredNotificationSource = Readonly<{
  kind: "covered";
  register(wake: Int32Array): (() => void) | void;
}>;

export type UncoveredNotificationSource = Readonly<{
  kind: "uncovered";
}>;

export type NotificationSource = CoveredNotificationSource | UncoveredNotificationSource;
export type NotificationWaitResult = "ok" | "not-equal" | "timed-out";

export interface NotificationWaitSet {
  readonly wake: Int32Array;
  readonly covered: boolean;
  readonly disposed: boolean;
  sample(): number;
  wait(observed: number, deadline: number): NotificationWaitResult;
  dispose(): void;
}

export interface NotificationWaitSetOptions {
  readonly now?: () => number;
  readonly wait?: (wake: Int32Array, observed: number, timeout: number) => NotificationWaitResult;
}

const perfNow = performance.now.bind(performance);

function waitOnWake(wake: Int32Array, observed: number, timeout: number): NotificationWaitResult {
  return atomicsWait(wake, 0, observed, timeout);
}

interface CleanupResult {
  readonly failed: boolean;
  readonly error: unknown;
}

function invokeRelease(release: () => void): CleanupResult {
  try {
    release();
    return { failed: false, error: undefined };
  } catch (error) {
    return { failed: true, error };
  }
}

function releaseAll(releases: (() => void)[]): CleanupResult {
  let failed = false;
  let firstError: unknown;
  for (let index = releases.length - 1; index >= 0; index--) {
    const result = invokeRelease(releases[index]!);
    if (!result.failed || failed) continue;
    failed = true;
    firstError = result.error;
  }
  releases.length = 0;
  return { failed, error: firstError };
}

export function createNotificationWaitSet(
  sources: readonly NotificationSource[],
  options: NotificationWaitSetOptions = {},
): NotificationWaitSet {
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const releases: (() => void)[] = [];
  const now = options.now ?? perfNow;
  const wait = options.wait ?? waitOnWake;
  let disposed = false;
  let covered = true;
  try {
    for (const source of sources) {
      if (source.kind === "uncovered") {
        covered = false;
        continue;
      }
      if (source.kind !== "covered") throw new TypeError("invalid notification source kind");
      const release = source.register(wake);
      if (release) releases.push(release);
    }
  } catch (error) {
    releaseAll(releases);
    throw error;
  }
  return {
    wake,
    get covered() {
      return covered;
    },
    get disposed() {
      return disposed;
    },
    sample() {
      return atomicsLoad(wake, 0);
    },
    wait(observed, deadline) {
      if (disposed) return "not-equal";
      const remaining = deadline === Infinity ? Infinity : Math.max(0, deadline - now());
      if (remaining === 0) return "timed-out";
      const timeout = covered ? remaining : Math.min(remaining, 10);
      return wait(wake, observed, timeout);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      atomicsNotify(wake, 0);
      const cleanup = releaseAll(releases);
      if (cleanup.failed) throw cleanup.error;
    },
  };
}
