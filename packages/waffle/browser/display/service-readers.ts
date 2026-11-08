import { allocateSharedControl } from "../../memory/control.js";
import {
  atomicsCompareExchange, atomicsLoad, atomicsNotify, Int32ArrayConstructor,
  sharedArrayBufferByteLength,
} from "../../proc/intrinsics.js";
import { atomicsWaitAsync } from "../../proc/intrinsics/host.js";

export interface ServiceAccess {
  run(work: () => undefined): "ran" | "closed";
}
export interface JoinedServiceReaders {
  readonly kind: "joined-service-readers";
}
export interface ClosedServiceReaders {
  join(): Promise<JoinedServiceReaders>;
  accepts(proof: unknown): proof is JoinedServiceReaders;
}
export interface ServiceReaderFence {
  readonly bootstrap: SharedArrayBuffer;
  close(): ClosedServiceReaders;
}

/** One allocation, one incarnation. Neither attachment nor close resets its word. */
export function createServiceReaders(): ServiceReaderFence {
  const bootstrap = allocateSharedControl(64);
  const cells = new Int32ArrayConstructor(bootstrap, 0, 1);
  const proof: JoinedServiceReaders = Object.freeze({ kind: "joined-service-readers" });
  let joined: Promise<JoinedServiceReaders> | undefined;
  const closed: ClosedServiceReaders = Object.freeze({
    join: () => (joined ??= join(cells).then(() => proof)),
    accepts: (value: unknown): value is JoinedServiceReaders => value === proof,
  });
  return Object.freeze({
    bootstrap,
    close() {
      let seen = atomicsLoad(cells, 0);
      while (seen >= 0) {
        const prior = atomicsCompareExchange(cells, 0, seen, -(seen + 1));
        if (prior === seen) break;
        seen = prior;
      }
      return closed;
    },
  });
}
async function join(cells: Int32Array): Promise<void> {
  for (;;) {
    const seen = atomicsLoad(cells, 0);
    if (seen === -1) return;
    if (seen >= 0) throw new Error("GPU service readers are not closed");
    const wait = atomicsWaitAsync(cells, 0, seen);
    if (wait.async) await wait.value;
  }
}
export function attachServiceAccess(bootstrap: SharedArrayBuffer): ServiceAccess {
  if (sharedArrayBufferByteLength(bootstrap) !== 64)
    throw new TypeError("Invalid GPU service reader allocation");
  const cells = new Int32ArrayConstructor(bootstrap, 0, 1);
  return Object.freeze({
    run(work: () => undefined) {
      if (!enter(cells)) return "closed";
      try {
        work();
        return "ran";
      } finally {
        leave(cells);
      }
    },
  });
}
function enter(cells: Int32Array): boolean {
  let seen = atomicsLoad(cells, 0);
  while (seen >= 0) {
    if (seen === 0x7fffffff) throw new RangeError("GPU service reader count exhausted");
    const prior = atomicsCompareExchange(cells, 0, seen, seen + 1);
    if (prior === seen) return true;
    seen = prior;
  }
  return false;
}
function leave(cells: Int32Array): void {
  let seen = atomicsLoad(cells, 0);
  for (;;) {
    if (seen === 0 || seen === -1) throw new Error("Unbalanced GPU service reader section");
    const next = seen > 0 ? seen - 1 : seen + 1;
    const prior = atomicsCompareExchange(cells, 0, seen, next);
    if (prior === seen) {
      if (next === -1) atomicsNotify(cells, 0);
      return;
    }
    seen = prior;
  }
}
