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
