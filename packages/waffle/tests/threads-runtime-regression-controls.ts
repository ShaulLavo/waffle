import { readWaitRegistration } from "../interrupt/wait.js";
import type { GuestWorkerEvent, GuestWorkerRequest } from "../thread/guest-worker.js";
import type { RuntimeThreadOwner } from "../thread/runtime-owner.js";
import type { GrowthObservation } from "./threads-runtime-growth-worker.js";
import {
  admissionLayout,
  fatalLayout,
  growthLayout,
  maxThreadId,
  overlapLayout,
  tidLayout,
} from "./threads-runtime-regression-modules.js";

export function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
export async function until(predicate: () => boolean, label = "thread observation"): Promise<void> {
  let timer: ReturnType<typeof setInterval>;
  await deadline(
    new Promise<void>((resolve, reject) => {
      const poll = () => {
        try {
          if (predicate()) resolve();
        } catch (error) {
          reject(error);
        }
      };
      timer = setInterval(poll, 5);
      poll();
    }),
    label,
  ).finally(() => clearInterval(timer));
}
export function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
}

type GuestObservation = {
  readonly worker: Worker;
  readonly request: GuestWorkerRequest;
  readonly handler: Worker["onmessage"];
  readonly events: { event: GuestWorkerEvent; at: number }[];
  enters: number;
};
type ServiceRead = { tid: number; pid: number };
type ObservedMessage =
  | GuestWorkerEvent
  | GrowthObservation
  | ({ kind: "fixture-stdin-pending" | "fixture-stdin-settled" } & ServiceRead);
export class ThreadRegressionObservations {
  readonly guests = new Map<number, GuestObservation>();
  readonly growth: GrowthObservation[] = [];
  stdin: ServiceRead | undefined;
  stdinSettled: ServiceRead | undefined;
  private memory: WebAssembly.Memory | undefined;
  constructor(private readonly stopped: ReadonlySet<Worker>) {}
  attach(worker: Worker, target: string): void {
    if (!/guest-bootstrap|thread-guest|thread-growth|thread-barrier/.test(target)) return;
    worker.addEventListener("message", ({ data }: MessageEvent<ObservedMessage>) => {
      if (!data || typeof data !== "object" || !("kind" in data)) return;
      if (data.kind === "fixture-stdin-pending") {
        this.stdin = data;
        return;
      }
      if (data.kind === "fixture-stdin-settled") {
        this.stdinSettled = data;
        return;
      }
      if (data.kind === "growth-observed") {
        this.growth.push(data);
        return;
      }
      if ("thread" in data)
        this.guests.get(data.thread.tid)?.events.push({ event: data, at: performance.now() });
    });
  }
  post(worker: Worker, message: unknown): void {
    if (!message || typeof message !== "object") return;
    if ("module" in message && "entry" in message && "waits" in message) {
      const request = message as GuestWorkerRequest;
      this.memory = request.memory;
      this.guests.set(request.thread.tid, {
        request,
        worker,
        handler: worker.onmessage,
        events: [],
        enters: 0,
      });
      return;
    }
    if (!("kind" in message) || message.kind !== "enter") return;
    const guest = Array.from(this.guests.values()).find((item) => item.worker === worker);
    if (guest) guest.enters++;
  }
  word(address: number): number {
    return Atomics.load(this.words(), address / 4);
  }
  signal(address: number, value = 1): void {
    const words = this.words();
    Atomics.store(words, address / 4, value);
    Atomics.notify(words, address / 4);
  }
  wake(address: number, width: 4 | 8): number {
    const words = this.words();
    return width === 4
      ? Atomics.notify(words, address / width, 1)
      : Atomics.notify(new BigInt64Array(words.buffer), address / width, 1);
  }
  waiting(tid: number, address: number, width: 4 | 8): boolean {
    const guest = this.guests.get(tid);
    if (!guest) return false;
    const current = readWaitRegistration(new Int32Array(guest.request.waits));
    return current?.address === address && current.width === width;
  }
  event(tid: number, kind: GuestWorkerEvent["kind"]) {
    return this.guests.get(tid)?.events.find((item) => item.event.kind === kind);
  }
  retired(tid: number): boolean {
    const guest = this.guests.get(tid);
    return !!guest && this.stopped.has(guest.worker);
  }
  entries(tid: number): number | undefined {
    return this.guests.get(tid)?.enters;
  }
  private words() {
    check(this.memory, "missing guest memory");
    return new Int32Array(this.memory.buffer);
  }
}

type Observations = ThreadRegressionObservations;
export async function releaseFatalThread(control: Observations, pid: number): Promise<void> {
  const p = fatalLayout;
  await until(
    () =>
      control.stdin?.tid === 2 &&
      control.waiting(3, p.timer, 8) &&
      control.waiting(4, p.exit, 4) &&
      control.waiting(1, p.main, 4),
    "same-PID stdin, finite wait and exit barriers",
  );
  check(control.stdin?.pid === pid && !control.stdinSettled, "same-PID stdin was still pending");
  checkFatalWrites(control);
  control.signal(p.exit);
}

function checkFatalWrites(control: Observations): void {
  const p = fatalLayout;
  for (const address of [
    p.bytes,
    p.count,
    p.sentinels,
    p.sentinels + 4,
    p.sentinels + 8,
    p.sentinels + 12,
  ])
    check(control.word(address) === 0, `terminal guest published a write at ${address}`);
}

export function checkFatalRetirement(control: Observations, pid: number) {
  checkFatalWrites(control);
  check(
    control.stdinSettled?.pid === pid && control.stdinSettled.tid === 2,
    "drain settled the same-PID stdin service call",
  );
  const tids = [1, 2, 3, 4];
  check(
    control.guests.size === tids.length &&
      tids.every(
        (tid) =>
          control.guests.get(tid)?.request.thread.pid === pid &&
          control.event(tid, "host-idle") &&
          control.retired(tid),
      ),
    "each same-PID guest must become idle and stop",
  );
  return { stdinTid: control.stdin?.tid, timedTid: 3, retiredTids: tids };
}

export async function runOverlappingWaits(control: Observations) {
  const p = overlapLayout;
  const tids = [2, 3] as const;
  await until(() => control.waiting(2, p.waits[0], 4), "wait32 armed before launching wait64");
  control.signal(p.launchSecond);
  await until(
    () => control.waiting(2, p.waits[0], 4) && control.waiting(3, p.waits[1], 8),
    "overlapping native wait32 and wait64 registrations",
  );
  control.signal(p.canaryGate);
  await until(() => control.word(p.canaryCount) === 1, "canonical fd_write during both waits");
  check(
    control.waiting(2, p.waits[0], 4) && control.waiting(3, p.waits[1], 8),
    "both waits must still be live after the canonical service reply",
  );
  await until(() => control.wake(p.waits[1], 8) === 1, "wake the parked wait64");
  await until(() => control.retired(3), "later wait64 completes while wait32 stays parked");
  check(control.waiting(2, p.waits[0], 4), "wait32 remained parked until wait64 completed");
  await until(() => control.wake(p.waits[0], 4) === 1, "wake the parked wait32");
  await until(() => control.retired(2), "ordinary return of the earlier waiter");
  const results = p.results.map((address) => [control.word(address), control.word(address + 4)]);
  check(
    results.every(([notified, timedOut]) => notified === 0 && timedOut === 2),
    "notify and timeout results",
  );
  const durationsMs = tids.map((tid) => {
    const armed = control.event(tid, "wait-registered");
    const cleared = control.event(tid, "wait-cleared");
    check(armed && cleared, "finite wait registration and clear observers");
    return cleared.at - armed.at;
  });
  control.signal(p.finish);
  return { results, durationsMs };
}

export async function runThreadAdmission(control: Observations) {
  const p = admissionLayout;
  await until(() => control.waiting(4, p.startGate, 4), "fourth thread pending in Wasm start");
  check(
    control.guests.size === 4 && !control.event(4, "ready"),
    "main and pending thread count at cap",
  );
  control.signal(p.firstRefusal);
  await until(
    () => control.word(p.pendingResult) !== 0,
    "spawn response with a pending fourth thread",
  );
  check(control.word(p.pendingResult) === -6, "signed refusal includes pending admission");
  control.signal(p.startGate);
  await until(() => control.word(p.admitted) === 4, "fourth thread accepted after ready");
  control.signal(p.secondRefusal);
  await until(
    () => control.word(p.runningResult) !== 0,
    "spawn response with a running fourth thread",
  );
  check(
    control.word(p.runningResult) === -6 && control.guests.size === 4,
    "signed refusal at cap without a worker",
  );

  control.signal(p.returnGate);
  await until(() => control.retired(3), "ordinary return releases exactly one slot");
  check(
    control.word(p.returned) === 1 &&
      control.event(3, "thread-returned") &&
      !control.retired(1) &&
      !control.retired(2) &&
      !control.retired(4),
    "ordinary return left all siblings running",
  );
  control.signal(p.startGate, 0);
  control.signal(p.retry);
  await until(() => control.waiting(5, p.startGate, 4), "fresh Worker reused the returned slot");

  replayRetiredEvents(control);
  control.signal(p.canary);
  await until(() => control.word(p.canaryCount) === 1, "sibling service canary after stale replay");
  check(
    control.entries(5) === 0 &&
      control.waiting(5, p.startGate, 4) &&
      !control.retired(5) &&
      control.word(p.replacementResult) === 0,
    "late ready/idle changed the pending replacement",
  );
  control.signal(p.startGate);
  await until(
    () => control.word(p.replacementResult) === 5 && control.word(p.replacementEntry) === 5,
    "replacement authentic ready and compiled entry",
  );
  check(control.entries(5) === 1, "replacement entered exactly once");
  control.signal(p.finish);
  return { pendingRefusal: -6, runningRefusal: -6, returned: 3, replacement: 5 };
}

function replayRetiredEvents(control: Observations): void {
  const old = control.guests.get(3);
  const replacement = control.guests.get(5);
  check(
    old && old.handler && replacement?.handler && old.worker !== replacement.worker,
    "distinct former and replacement owner callbacks",
  );
  for (const kind of ["ready", "host-idle"] as const) {
    const captured = control.event(3, kind);
    check(captured, `retired worker has no ${kind} for replay`);
    const event = new MessageEvent("message", { data: captured.event });
    old.handler.call(old.worker, event);
    replacement.handler.call(replacement.worker, event);
  }
}

export async function observeThreadOwner() {
  const { RuntimeThreadOwner } = await import("../thread/runtime-owner.js");
  const create = RuntimeThreadOwner.create;
  let owner: RuntimeThreadOwner | undefined;
  RuntimeThreadOwner.create = async (options) => (owner = await create(options));
  return {
    seed(expected: number, next: number) {
      check(
        owner && Reflect.get(owner, "tid") === expected,
        `expected allocator cursor ${expected}`,
      );
      check(Reflect.set(owner, "tid", next), "could not seed the allocator cursor");
    },
    restore() {
      RuntimeThreadOwner.create = create;
    },
  };
}

export async function runThreadIds(
  control: Observations,
  allocator: Awaited<ReturnType<typeof observeThreadOwner>>,
) {
  const p = tidLayout;
  await until(() => control.waiting(1, p.gates[0], 4), "initial guest reached the first TID gate");
  allocator.seed(1, 65534);
  await checkThreadId(control, 0, 65535);
  await checkThreadId(control, 1, 65536);
  allocator.seed(65536, maxThreadId - 1);
  await checkThreadId(control, 2, maxThreadId);
  control.signal(p.gates[3]);
  await until(() => control.word(p.results[3]) !== 0, "signed exhaustion result");
  check(
    control.word(p.results[3]) === -6 &&
      control.word(p.entries[3]) === 0 &&
      control.guests.size === 4,
    "exhaustion must fail without launching or entering a Worker",
  );
  control.signal(p.finish);
  return { results: p.results.map((address) => control.word(address)) };
}

async function checkThreadId(control: Observations, index: number, tid: number): Promise<void> {
  const p = tidLayout;
  control.signal(p.gates[index]!);
  await until(
    () => control.word(p.results[index]!) !== 0 && control.retired(tid),
    `TID ${tid} returns and retires`,
  );
  check(
    control.word(p.results[index]!) === tid &&
      control.word(p.entries[index]!) === tid &&
      control.event(tid, "thread-returned"),
    `TID ${tid} round trip through the owner and compiled entry`,
  );
}

export async function runReceivingGrowth(control: Observations) {
  await until(() => control.growth.length === 3, "receiving Worker growth observations");
  const phases = ["received", "instantiated", "returned"];
  const extents = [2, 3, 4].map((pages) => pages * 65536);
  const optional = control.growth[0]?.resizable;
  for (const [index, sample] of control.growth.entries()) {
    check(
      sample.phase === phases[index] &&
        sample.fixed === extents[0] &&
        sample.refreshed === extents[index],
      `receiving Worker fixed views: ${JSON.stringify(sample)}`,
    );
    check(
      sample.resizable === (typeof optional === "number" ? extents[index] : optional),
      `receiving Worker resizable view: ${JSON.stringify(sample)}`,
    );
  }
  check(
    control.word(growthLayout.first + 16) === 1 && control.word(growthLayout.second + 16) === 1,
    "both guest host calls wrote their result beyond the previous extent",
  );
  control.signal(growthLayout.finished);
  return { views: control.growth };
}
