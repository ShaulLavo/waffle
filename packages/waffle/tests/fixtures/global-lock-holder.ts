// Holds the shared filesystem global lock from another thread, as a guest's direct I/O does.
// control: [0] command (1 = hold), [1] state (1 = held, 2 = released), [2] early release.

interface Hold {
  cells: SharedArrayBuffer;
  control: SharedArrayBuffer;
  owner: number;
  holdMs: number;
  /** Words to set while the lock is held, after afterMs, as another thread would. */
  signal?: { buffer: SharedArrayBuffer; index: number; value: number; afterMs: number };
  /** Never release: the holder dies with the lock. */
  keep?: boolean;
}

const GLOBAL_LOCK = 1;

self.onmessage = ({ data }: MessageEvent<Hold>) => {
  const cells = new Int32Array(data.cells);
  const control = new Int32Array(data.control);
  Atomics.wait(control, 0, 0);
  while (Atomics.compareExchange(cells, GLOBAL_LOCK, 0, data.owner) !== 0);
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
  if (data.signal) {
    Atomics.wait(control, 2, 0, data.signal.afterMs);
    Atomics.store(new Int32Array(data.signal.buffer), data.signal.index, data.signal.value);
  }
  if (data.keep) return;
  Atomics.wait(control, 2, 0, data.holdMs);
  Atomics.compareExchange(cells, GLOBAL_LOCK, data.owner, 0);
  Atomics.store(control, 1, 2);
  Atomics.notify(control, 1);
};
