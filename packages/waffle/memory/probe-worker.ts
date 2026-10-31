import { PAGE_BYTES, PROBE_CEILING_BYTES, type ReservationKind } from "./reservations";

interface ProbeRequest { readonly ceilingBytes?: number }
interface ProbeResult {
  readonly growableBytes: number;
  readonly ceilingReached: boolean;
  readonly counts: Readonly<Record<Exclude<ReservationKind, "growable-buffer">, boolean>>;
}

function growableBuffer(maxByteLength: number): SharedArrayBuffer {
  const value = Reflect.construct(SharedArrayBuffer, [0, { maxByteLength }]);
  if (!(value instanceof SharedArrayBuffer)) throw new TypeError("probe did not create SharedArrayBuffer");
  return value;
}

function probe(event: MessageEvent<ProbeRequest>): ProbeResult {
  const ceiling = event.data?.ceilingBytes ?? PROBE_CEILING_BYTES;
  let current: SharedArrayBuffer | undefined;
  let growableBytes = 0;
  const coarse = 256 * 1024 * 1024;
  const fine = 16 * 1024 * 1024;
  let step = coarse;
  let ceilingReached = false;
  for (;;) {
    const next = Math.min(ceiling, growableBytes + step);
    try {
      current = growableBuffer(next);
      growableBytes = next;
      if (growableBytes === ceiling) { ceilingReached = true; break; }
    } catch {
      if (step === fine) break;
      step = fine;
    }
  }
  if (ceilingReached) return { growableBytes, ceilingReached, counts: { "fixed-buffer": true, "shared-memory": true, "private-memory": true } };
  const counts = {
    "fixed-buffer": true,
    "shared-memory": true,
    "private-memory": true,
  };
  try { new SharedArrayBuffer(fine); counts["fixed-buffer"] = false; } catch {}
  try { new WebAssembly.Memory({ initial: fine / PAGE_BYTES, maximum: fine / PAGE_BYTES, shared: true }); counts["shared-memory"] = false; } catch {}
  try { new WebAssembly.Memory({ initial: fine / PAGE_BYTES, maximum: fine / PAGE_BYTES }); counts["private-memory"] = false; } catch {}
  void current;
  return { growableBytes, ceilingReached, counts };
}

self.onmessage = event => {
  try {
    self.postMessage(probe(event));
  } finally {
    self.close();
  }
};
