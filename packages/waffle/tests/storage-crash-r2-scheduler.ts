interface FaultPoint {
  adapter: "indexeddb" | "opfs";
  operation: string;
  target: string;
}
export interface FaultEvent extends FaultPoint {
  resource: string;
}
export interface FaultSchedule {
  id: string;
  at: FaultPoint;
  occurrence: number;
}
export class FaultScheduler {
  readonly events: (FaultEvent & { ordinal: number; injected: boolean })[] = [];
  readonly reason: Error;
  private matches = 0;
  private fired = false;
  constructor(readonly schedule: FaultSchedule | null) {
    this.reason = new Error(`Injected storage fault: ${schedule?.id ?? "control"}`);
  }
  visit(event: FaultEvent): boolean {
    const matches =
      this.schedule !== null &&
      event.adapter === this.schedule.at.adapter &&
      event.operation === this.schedule.at.operation &&
      event.target === this.schedule.at.target;
    if (matches) this.matches++;
    const injected = !this.fired && matches && this.matches === this.schedule?.occurrence;
    this.events.push({ ...event, ordinal: this.events.length + 1, injected });
    if (injected) this.fired = true;
    return injected;
  }
  inject(event: FaultEvent): void {
    if (this.visit(event)) throw this.reason;
  }
  assertReached(): void {
    if (this.schedule && !this.fired) throw new Error(`Unreached schedule: ${this.schedule.id}`);
  }
}

export async function runFaultSchedules<
  Cell extends { id: string; schedule: FaultSchedule | null },
  Result,
>(cells: readonly Cell[], run: (cell: Cell, scheduler: FaultScheduler) => Promise<Result>) {
  const results = [];
  for (const cell of cells) {
    const scheduler = new FaultScheduler(cell.schedule);
    try {
      results.push(await run(cell, scheduler));
    } catch (error) {
      results.push({
        id: cell.id,
        ok: false,
        schedule: cell.schedule,
        events: scheduler.events,
        error: failureText(error),
      });
    }
  }
  return results;
}

function failureText(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}\n${error.errors.map(failureText).join("\n")}`;
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export async function withCellCleanup<Result>(
  run: () => Promise<Result>,
  cleanup: () => Promise<void>,
): Promise<Result> {
  const [operation] = await Promise.allSettled([Promise.resolve().then(run)]);
  const [released] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
  const failures = [operation, released].flatMap((result) =>
    result?.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Storage cell operation or cleanup failed");
  if (operation?.status !== "fulfilled") throw new Error("Storage cell did not settle");
  return operation.value;
}

export function causedBy(error: unknown, expected: Error): boolean {
  if (error === expected) return true;
  return error instanceof Error && causedBy(error.cause, expected);
}
