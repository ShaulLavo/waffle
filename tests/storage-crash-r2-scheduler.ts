export interface FaultEvent {
  adapter: "indexeddb" | "opfs";
  operation: string;
  target: string;
}
export interface FaultSchedule {
  id: string;
  at: FaultEvent;
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
        error: error instanceof Error ? error.stack : String(error),
      });
    }
  }
  return results;
}
