import type { HostWorker } from "./protocol.js";

export type ConsoleFailure = Readonly<{
  context: "page" | HostWorker;
  source: string;
  type?: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
}>;
export type WorkerConsoleOrder = Readonly<{
  worker: HostWorker;
  enableWritten: number;
  forwarded?: number;
  replied?: number;
  initialized?: number;
  terminated?: number;
}>;
export type ConsoleSummary = Readonly<{
  first: ConsoleFailure | null;
  loss: string | null;
  workers: readonly WorkerConsoleOrder[];
}>;

export class ConsoleObservation {
  private first: ConsoleFailure | null = null;
  private loss: string | null = null;
  private frozen: ConsoleSummary | undefined;
  constructor(private readonly orders: () => readonly WorkerConsoleOrder[] = () => []) {}
  added(failure: ConsoleFailure): void {
    if (this.frozen || this.first) return;
    this.first = Object.freeze({ ...failure, text: failure.text.slice(0, 1024) });
  }
  lose(reason: string): void {
    if (!this.frozen) this.loss ??= reason.slice(0, 1024);
  }
  summary(): ConsoleSummary {
    return (
      this.frozen ?? Object.freeze({ first: this.first, loss: this.loss, workers: this.orders() })
    );
  }
  freeze(): ConsoleSummary {
    return (this.frozen ??= this.summary());
  }
}
