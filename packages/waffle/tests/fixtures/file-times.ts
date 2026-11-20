/** A whole-millisecond time in nanoseconds. */
export function ms(value: number): bigint {
  return BigInt(value) * 1_000_000n;
}

/** Test times: one millisecond value for atime, mtime and ctime. */
export function statTimes(ms: number): { atime: bigint; mtime: bigint; ctime: bigint } {
  const time = BigInt(ms) * 1_000_000n;
  return { atime: time, mtime: time, ctime: time };
}

/** The same times as persisted records store them. */
export function storedTimes(ms: number): { atime: string; mtime: string; ctime: string } {
  const time = `${BigInt(ms) * 1_000_000n}`;
  return { atime: time, mtime: time, ctime: time };
}
