export function ringSnapshot(backing: SharedArrayBuffer) {
  const publication = Atomics.load(new BigInt64Array(backing, 0, 1), 0);
  const cells = new Int32Array(backing, 0, 16);
  const head = Number(publication & 0xffffffffn);
  const tail = Atomics.load(cells, 2) >>> 0;
  return {
    capacity: backing.byteLength - 64,
    head,
    tail,
    used: (head - tail) >>> 0,
    writer: Atomics.load(cells, 3),
    terminal: Number((publication >> 32n) & 0xffffffffn),
  };
}

export function captureRingSnapshots() {
  const captured = new Map<SharedArrayBuffer, ReturnType<typeof ringSnapshot>>();
  return (backing: SharedArrayBuffer) => {
    const previous = captured.get(backing);
    if (previous) return previous;
    const value = ringSnapshot(backing);
    captured.set(backing, value);
    return value;
  };
}
