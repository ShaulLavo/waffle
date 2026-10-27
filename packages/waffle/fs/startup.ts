/** Fixed, payload-free milestones for the initial page filesystem worker only. */
export type RuntimeStartupStage =
  | "filesystem-worker-created"
  | "filesystem-connect-requested"
  | "filesystem-connected"
  | "indexeddb-open-requested"
  | "indexeddb-open-resolved"
  | "filesystem-lock-requested"
  | "filesystem-lock-acquired"
  | "filesystem-epoch-requested"
  | "filesystem-epoch-resolved"
  | "filesystem-ready";

/** Timestamp is performance.timeOrigin + performance.now(), in milliseconds in the emitting
 * realm. Observers must not reenter runtime control; throws and async rejections are ignored. */
export type RuntimeStartupObserver = (
  stage: RuntimeStartupStage,
  timestamp: number,
) => void | PromiseLike<void>;

/** No clock read or diagnostic allocation when observation is disabled. Never await an observer. */
export function reportRuntimeStartup(
  observer: RuntimeStartupObserver | undefined,
  stage: RuntimeStartupStage,
  timestamp?: number,
): void {
  if (!observer) return;
  try {
    const pending = observer(stage, timestamp ?? performance.timeOrigin + performance.now());
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    /* Diagnostics cannot own startup, storage or teardown. */
  }
}

/** Validate at the worker boundary; never forward arbitrary message data to the consumer. */
export function isWorkerStartupMessage(
  data: unknown,
): data is { type: "filesystem-startup"; stage: RuntimeStartupStage; timestamp: number } {
  if (
    !data ||
    typeof data !== "object" ||
    !("type" in data) ||
    data.type !== "filesystem-startup" ||
    !("timestamp" in data) ||
    typeof data.timestamp !== "number" ||
    !Number.isFinite(data.timestamp) ||
    !("stage" in data)
  )
    return false;
  switch (data.stage) {
    case "filesystem-connected":
    case "indexeddb-open-requested":
    case "indexeddb-open-resolved":
    case "filesystem-lock-requested":
    case "filesystem-lock-acquired":
    case "filesystem-epoch-requested":
    case "filesystem-epoch-resolved":
    case "filesystem-ready":
      return true;
    default:
      return false;
  }
}
