import {
  ACKNOWLEDGED,
  elapsedFrom,
  Field,
  MAX_VALUE,
  OperationCells,
  operationClock,
  PIPE_OFFSET,
  RESOLVE_OFFSET,
  Result,
  type ResultCode,
  type ResultName,
} from "./cells.js";
import type { GuestOperationBinding, OperationBinding } from "./protocol.js";

export interface OperationWriter {
  begin(id: number): void;
  settle(result: ResultName): void;
  submissionFailed(result: ResultName): void;
}

const staleCapture = new Error("Operation capture was retired");

class Writer implements OperationWriter {
  #sequence: number;
  #started: number | undefined;
  constructor(
    readonly cells: OperationCells,
    readonly offset: number,
    readonly origin: number,
  ) {
    const previous = cells.read(offset + Field.sequence);
    this.#sequence = previous !== undefined && previous % 2 === 0 ? previous : MAX_VALUE;
  }
  begin(id: number): void {
    // Both begin and settlement use an odd and an even sequence value.
    if (this.#started !== undefined || this.#sequence > MAX_VALUE - 5) return;
    try {
      const started = operationClock();
      if (!this.open()) return;
      this.put(Field.started, elapsedFrom(this.origin, started));
      this.put(Field.active, id);
      this.close();
      this.#started = started;
    } catch {
      this.#sequence = MAX_VALUE;
    }
  }
  settle(result: ResultName): void {
    const started = this.#started;
    if (started === undefined) return;
    this.#started = undefined;
    this.finish(Result[result], started);
  }
  submissionFailed(result: ResultName): void {
    this.finish(Result[result], undefined);
  }
  private finish(result: ResultCode, started: number | undefined): void {
    try {
      if (!this.open()) return;
      const count =
        result === Result.completed
          ? Field.completed
          : result <= Result.filesystemCancelled
            ? Field.cancelled
            : Field.failed;
      const previous = this.cells.read(this.offset + count);
      if (previous === undefined) throw staleCapture;
      this.put(count, previous === MAX_VALUE ? previous : previous + 1);
      this.put(Field.result, result);
      this.put(Field.duration, started === undefined ? 0 : elapsedFrom(started));
      this.put(Field.timed, started === undefined ? 0 : 1);
      this.put(Field.active, 0);
      this.close();
    } catch {
      this.#sequence = MAX_VALUE;
    }
  }
  private open(): boolean {
    if (this.#sequence >= MAX_VALUE - 1) return false;
    this.put(Field.sequence, ++this.#sequence);
    return true;
  }
  private close(): void {
    this.put(Field.sequence, ++this.#sequence);
  }
  private put(field: number, value: number): void {
    if (!this.cells.write(this.offset + field, value)) throw staleCapture;
  }
}

export function createOperationWriters(binding: GuestOperationBinding) {
  const cells = new OperationCells(binding);
  return {
    pipe: new Writer(cells, PIPE_OFFSET, binding.origin),
    resolve: new Writer(cells, RESOLVE_OFFSET, binding.origin),
  };
}

export function captureAcceptance(binding: OperationBinding): (id: number) => void {
  const cells = new OperationCells(binding);
  return (id) => {
    const previous = cells.read(ACKNOWLEDGED);
    if (previous !== undefined && id > previous) cells.write(ACKNOWLEDGED, id);
  };
}
