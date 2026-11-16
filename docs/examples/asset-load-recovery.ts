export interface LoadFailure {
  readonly kind: "lazy-service" | "worker-entry";
  readonly resource: string;
  readonly cause: unknown;
}

interface RecoveryOptions {
  showFailure(failure: LoadFailure): void;
  /** Stop edits and writers, save editor buffers, then await filesystem.flush(). */
  preserve(): Promise<void>;
  storage(): Pick<Storage, "getItem" | "setItem">;
  navigate(): void;
}

const guardKey = "waffle:load-recovery-attempted";

/** Consumer policy only. Reporting never reloads, disposes, or replays work. */
export function createLoadRecovery(options: RecoveryOptions) {
  let failure: LoadFailure | undefined;
  let pending: Promise<"navigating" | "blocked"> | undefined;

  function report(next: LoadFailure): void {
    if (failure) return;
    failure = next;
    options.showFailure(next);
  }

  async function preserveAndNavigate(): Promise<"navigating" | "blocked"> {
    let storage: ReturnType<RecoveryOptions["storage"]>;
    try {
      storage = options.storage();
      if (storage.getItem(guardKey) !== null) return "blocked";
    } catch {
      return "blocked";
    }
    await options.preserve();
    try {
      storage.setItem(guardKey, "attempted");
      if (storage.getItem(guardKey) !== "attempted") return "blocked";
    } catch {
      return "blocked";
    }
    options.navigate();
    return "navigating";
  }

  return {
    report,
    /** Call from an explicit recovery action, after displaying the failure. */
    reload(): Promise<"navigating" | "blocked"> {
      if (!failure) return Promise.resolve("blocked");
      pending ??= preserveAndNavigate();
      return pending;
    },
    async load<T>(resource: string, load: () => Promise<T>): Promise<T> {
      try {
        return await load();
      } catch (cause) {
        try {
          report({ kind: "lazy-service", resource, cause });
        } catch {
          // A presentation failure must not replace the original load failure.
        }
        throw cause;
      }
    },
  };
}

/** Attach immediately after construction, before posting startup messages. */
export function observeWorkerEntry(
  worker: Pick<Worker, "addEventListener" | "removeEventListener">,
  resource: string,
  report: (failure: LoadFailure) => void,
): () => void {
  const failed = (cause: ErrorEvent) => report({ kind: "worker-entry", resource, cause });
  worker.addEventListener("error", failed);
  return () => worker.removeEventListener("error", failed);
}
