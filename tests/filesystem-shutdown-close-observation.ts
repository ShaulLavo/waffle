import {
  before,
  failureReasons,
  isFailureReason,
  observe,
  pending,
  shutdownArms,
  stamp,
  type BeforeRecorder,
  type FailureReason,
  type Outcome,
  type ShutdownArm,
  type Stage,
  type Stamp,
} from "./filesystem-shutdown-browser.js";
import type { ResourceCloseEvent } from "./process-recycling-browser-runner-control.js";

type CloseContext = {
  close(): Promise<void>;
  once(event: "close", listener: () => void): unknown;
};
type Settlement<T> = { kind: "pending" } | { at: Stamp; outcome: Outcome<T> };
type Original<C> =
  | { kind: "not-invoked" }
  | { kind: "lookup-threw"; at: Stamp; reason: unknown }
  | { kind: "call-threw"; at: Stamp; threwAt: Stamp; reason: unknown }
  | { kind: "returned"; context: C; promise: Promise<void>; at: Stamp; settled: Settlement<void> };

/** Owns only the original call. Snapshots never join it or change its capped result. */
export class ContextCloseObservation<C extends CloseContext> {
  allocation: Stage<C> = pending();
  original: Original<C> = { kind: "not-invoked" };
  closeEvent: Stage<Stamp> = pending();
  bounded: Stage<void> = pending();
  readonly recorder: BeforeRecorder<void> = { events: [] };
  readonly observerErrors: unknown[] = [];
  readonly outer: {
    event: "started" | "fulfilled" | "rejected";
    at: Stamp;
    original: ReturnType<ContextCloseObservation<C>["originalSnapshot"]>;
    reason?: unknown;
  }[] = [];
  constructor(
    readonly id: string,
    private context: Promise<C>,
  ) {
    void observe(context).then((outcome) => {
      this.allocation = outcome;
    });
  }
  private invoke(context: C): Promise<void> {
    try {
      context.once("close", () => {
        this.closeEvent = { kind: "fulfilled", value: stamp() };
      });
    } catch (reason) {
      this.observerErrors.push(reason);
    }
    let close: C["close"];
    try {
      close = context.close;
    } catch (reason) {
      this.original = { kind: "lookup-threw", at: stamp(), reason };
      throw reason;
    }
    return this.call(context, close);
  }
  private call(context: C, close: C["close"]): Promise<void> {
    const at = stamp();
    try {
      const promise = close.call(context);
      const original: Original<C> = {
        kind: "returned",
        context,
        promise,
        at,
        settled: { kind: "pending" },
      };
      this.original = original;
      void promise.then(
        (value) => {
          this.original = {
            ...original,
            settled: { at: stamp(), outcome: { kind: "fulfilled", value } },
          };
        },
        (reason: unknown) => {
          this.original = {
            ...original,
            settled: { at: stamp(), outcome: { kind: "rejected", reason } },
          };
        },
      );
      return promise;
    } catch (reason) {
      this.original = { kind: "call-threw", at, threwAt: stamp(), reason };
      throw reason;
    }
  }
  async observeBefore(deadline: number): Promise<Outcome<void>> {
    const result = await before(
      deadline,
      "owned context close",
      async () => this.invoke(await this.context),
      1000,
      this.recorder,
    );
    this.bounded = result;
    return result;
  }
  originalSnapshot() {
    const original = this.original;
    if (original.kind !== "returned") return original;
    return {
      kind: original.kind,
      at: original.at,
      settled: original.settled,
      retainedPromise: true,
      exactAllocatedContext:
        this.allocation.kind === "fulfilled" && this.allocation.value === original.context,
    };
  }
  enclosing(event: ResourceCloseEvent): void {
    const snapshot = { event: event.kind, at: stamp(), original: this.originalSnapshot() };
    this.outer.push(event.kind === "rejected" ? { ...snapshot, reason: event.reason } : snapshot);
  }
  snapshot() {
    return {
      id: this.id,
      allocation: this.allocation.kind === "fulfilled" ? { kind: "fulfilled" } : this.allocation,
      original: this.originalSnapshot(),
      closeEvent: this.closeEvent,
      bounded: this.bounded,
      boundedCallback: this.recorder.events.map((event) =>
        event.kind === "operation-returned" ? { kind: event.kind, at: event.at } : event,
      ),
      observerErrors: this.observerErrors.slice(),
      outer: this.outer.slice(),
      at: stamp(),
    };
  }
}

type Engine = "chromium" | "firefox" | "webkit";
export function shutdownSelection(args: readonly string[]) {
  const selected: Engine[] = [];
  const seen = new Set<string>();
  let duplicateOption = false;
  let backend = "indexeddb";
  let reason: FailureReason | "all" = "all";
  let arm: "raw-close-failure" | undefined;
  let remainingFirefox = false;
  for (let i = 0; i < args.length; i++) {
    const item = args[i]!;
    if (item.startsWith("--")) {
      duplicateOption ||= seen.has(item);
      seen.add(item);
    }
    if (item === "--remaining-firefox") {
      remainingFirefox = true;
      continue;
    }
    if (item === "--backend") {
      backend = args[++i] ?? "";
      continue;
    }
    if (item === "--reason") {
      reason = selectionReason(args[++i]);
      continue;
    }
    if (item === "--arm") {
      arm = selectionArm(args[++i]);
      continue;
    }
    if (item !== "chromium" && item !== "firefox" && item !== "webkit")
      throw new Error(`Unknown shutdown engine/option: ${item}`);
    if (selected.includes(item)) throw new Error(`Duplicate engine: ${item}`);
    selected.push(item);
  }
  if (remainingFirefox) {
    if (args.length !== 2 || selected.length !== 1 || selected[0] !== "firefox")
      throw new Error("--remaining-firefox requires only firefox");
    return {
      selected,
      reasons: failureReasons.filter((item) => item !== "error"),
      arms: ["raw-close-failure"] satisfies readonly ShutdownArm[],
    };
  }
  if (backend !== "indexeddb") throw new Error("Only IndexedDB ordinary shutdown is allocated");
  if (selected.length === 0) throw new Error("Select at least one engine explicitly");
  if (arm && duplicateOption)
    throw new Error("Diagnostic selector does not accept repeated options");
  if (arm && (selected.length !== 1 || selected[0] !== "firefox" || reason !== "error"))
    throw new Error("--arm raw-close-failure requires exactly firefox and --reason error");
  const reasons = reason === "all" ? failureReasons : [reason];
  const arms: readonly ShutdownArm[] = arm ? [arm] : shutdownArms;
  return { selected, reasons, arms };
}
function selectionReason(input: string | undefined): FailureReason | "all" {
  if (input === "all" || isFailureReason(input)) return input;
  throw new Error(`Unknown failure reason: ${input}`);
}
function selectionArm(input: string | undefined): "raw-close-failure" {
  if (input === "raw-close-failure") return input;
  throw new Error(`Unknown diagnostic arm: ${input}`);
}
