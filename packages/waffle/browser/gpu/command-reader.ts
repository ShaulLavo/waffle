import type { ServiceAccess } from "../display/service-readers.js";
import type { CommandReadSource, CommandReadResult } from "./transport.js";
import type { RecordRing, RingAcquireResult } from "./ring.js";

/** Own the whole physical read, including both padding/record stores and exceptions. */
export class FencedCommandReader implements CommandReadSource {
  readonly #ring: RecordRing;
  constructor(ring: RecordRing, private readonly access: ServiceAccess) { this.#ring = ring; }
  get capacity() { return this.#ring.capacity; }
  get recordHeaderBytes() { return this.#ring.recordHeaderBytes; }
  terminal() {
    let result: ReturnType<RecordRing["terminal"]>;
    this.access.run(() => { result = this.#ring.terminal(); return undefined; });
    return result;
  }
  terminate(reason: number) {
    let result: ReturnType<RecordRing["terminate"]> | undefined;
    this.access.run(() => { result = this.#ring.terminate(reason); return undefined; });
    return result ?? { kind: "terminal" as const, reason };
  }
  sequence(): number {
    let seen = 0;
    this.access.run(() => { seen = this.#ring.sequence(); return undefined; });
    return seen;
  }
  waitAsync(seen: number, timeout = 10): ReturnType<RecordRing["waitAsync"]> {
    let wait: ReturnType<RecordRing["waitAsync"]> = { async: false, value: "terminal" };
    this.access.run(() => { wait = this.#ring.waitAsync(seen, timeout); return undefined; });
    return wait;
  }
  tryAcquireWriter(): RingAcquireResult {
    let acquired: RingAcquireResult = { kind: "terminal", reason: 5 };
    this.access.run(() => {
      const result = this.#ring.tryAcquireWriter();
      acquired = result.kind === "acquired" ? { kind: "acquired", writer: this.#writer(result.writer) } : result;
      return undefined;
    });
    return acquired;
  }
  #writer(writer: Extract<RingAcquireResult, { kind: "acquired" }>["writer"]) {
    const access = this.access;
    return {
      tryWrite(record: Uint8Array) {
        let result: ReturnType<typeof writer.tryWrite> = { kind: "terminal", reason: 5 };
        access.run(() => { result = writer.tryWrite(record); return undefined; });
        return result;
      },
      release() { access.run(() => { writer.release(); return undefined; }); },
    };
  }
  readInto(destination: Uint8Array): CommandReadResult {
    let result: CommandReadResult = { kind: "reader-closed" };
    this.access.run(() => { result = this.#ring.readInto(destination); return undefined; });
    return result;
  }
}
