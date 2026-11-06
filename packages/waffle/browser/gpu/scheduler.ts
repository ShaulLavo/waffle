import { CompletionOwner } from "./completions.js";
import { GpuReplay, type ReplayTarget } from "./replay.js";
import type { RecordRing } from "./ring.js";
import { GPU_TERMINAL, ServiceCredit, type ConnectionState } from "./protocol.js";
import { LogicalReader } from "./transport.js";

export interface SliceBudget {
  readonly bytes: number;
  readonly milliseconds: number;
  readonly now: () => number;
}
const DEFAULT_BUDGET: SliceBudget = {
  bytes: 1024 * 1024,
  milliseconds: 4,
  now: () => performance.now(),
};
export interface SliceResult {
  readonly bytes: number;
  readonly kind: "yield" | "idle" | "await" | "terminal";
}

/** One connection owns its ordinary heap, replay, completions and terminal cleanup. */
export class GpuConnection {
  readonly completions: CompletionOwner;
  readonly replay: GpuReplay;
  readonly #reader: LogicalReader;
  constructor(
    readonly commands: RecordRing,
    replies: RecordRing,
    target: ReplayTarget,
    credit: ServiceCredit,
    options: { maxLogical?: number; arena?: Uint8Array; handles?: number } = {},
  ) {
    this.completions = new CompletionOwner({ commands, replies, arena: options.arena });
    this.#reader = new LogicalReader(commands, credit, options.maxLogical);
    try {
      this.replay = new GpuReplay(target, this.completions, options.handles);
    } catch (error) {
      this.#reader.dispose();
      commands.terminate(GPU_TERMINAL.service);
      this.completions.terminate(GPU_TERMINAL.service);
      throw error;
    }
    this.completions.onRetire(() => {
      this.#reader.dispose();
      this.replay.dispose();
    });
  }
  get state(): ConnectionState {
    return this.completions.state;
  }
  close(reason: number = GPU_TERMINAL.closed): void {
    this.completions.terminate(reason);
  }
  slice(budget: SliceBudget = DEFAULT_BUDGET): SliceResult {
    if (
      !Number.isFinite(budget.bytes) ||
      budget.bytes < 1 ||
      !Number.isFinite(budget.milliseconds) ||
      budget.milliseconds <= 0
    )
      throw new RangeError("Invalid GPU replay budget");
    if (this.state.kind === "terminal") return { kind: "terminal", bytes: 0 };
    const start = budget.now();
    let bytes = 0;
    while (bytes < budget.bytes && budget.now() - start < budget.milliseconds) {
      const next = this.#step();
      bytes += next.bytes;
      if (next.kind !== "yield") return { kind: next.kind, bytes };
    }
    return { kind: "yield", bytes };
  }
  #step(): SliceResult {
    if (this.replay.busy) {
      const step = this.replay.step();
      if (step.kind !== "progress")
        return { kind: step.kind === "idle" ? "yield" : step.kind, bytes: 0 };
      return { kind: step.presented ? "await" : "yield", bytes: step.bytes };
    }
    const read = this.#reader.read();
    if (read.kind === "terminal") {
      this.close(read.reason);
      return { kind: "terminal", bytes: 0 };
    }
    if (read.kind === "empty")
      return { kind: this.completions.pendingCount ? "await" : "idle", bytes: 0 };
    if (read.kind === "record") this.replay.accept(read.record);
    return { kind: "yield", bytes: this.#reader.lastReadBytes };
  }
}

/** One bounded visit per connection. The driver yields a task before the next round. */
export class GpuScheduler {
  readonly #connections: GpuConnection[] = [];
  #next = 0;
  add(connection: GpuConnection): void {
    if (this.#connections.includes(connection)) return;
    if (this.#connections.length >= 8) throw new RangeError("GPU connection limit");
    this.#connections.push(connection);
  }
  remove(connection: GpuConnection): void {
    const index = this.#connections.indexOf(connection);
    if (index >= 0) this.#connections.splice(index, 1);
    if (this.#next >= this.#connections.length) this.#next = 0;
  }
  turn(budget: SliceBudget = DEFAULT_BUDGET): boolean {
    const count = this.#connections.length;
    let progress = false;
    for (let visit = 0; visit < count; visit++) {
      const index = (this.#next + visit) % count;
      const result = this.#connections[index]?.slice(budget);
      if (result && result.bytes > 0) progress = true;
    }
    this.#next = count ? (this.#next + 1) % count : 0;
    return progress;
  }
  async drain(yieldTask: () => Promise<void>, budget: SliceBudget = DEFAULT_BUDGET): Promise<void> {
    while (this.turn(budget)) await yieldTask();
  }
}

// Importing this module creates no ports or Worker. A responsive service supplies a
// MessageChannel task yielder to drain(), then arms its rings with waitAsync().
