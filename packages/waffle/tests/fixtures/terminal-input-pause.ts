export function pauseInputAcquisition(buffer: SharedArrayBuffer, pause: () => void): void {
  const cas = Atomics.compareExchange;
  Atomics.compareExchange = ((
    array: BigInt64Array,
    index: number,
    expected: bigint,
    replacement: bigint,
  ) => {
    const previous = cas(array, index, expected, replacement);
    if (
      array.buffer === buffer &&
      array.byteOffset === 16 &&
      index === 0 &&
      expected === 0n &&
      previous === 0n
    )
      pause();
    return previous;
  }) as typeof Atomics.compareExchange;
}

export function pauseInputRelease(buffer: SharedArrayBuffer, pause: () => void): void {
  const notify = Atomics.notify;
  Atomics.notify = (array, index, count) => {
    const woken =
      array instanceof BigInt64Array ? notify(array, index, count) : notify(array, index, count);
    if (array.buffer === buffer && array.byteOffset === 16 && index === 0) pause();
    return woken;
  };
}
