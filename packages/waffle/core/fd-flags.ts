export const FDFLAG_APPEND = 1;
export const FDFLAG_DSYNC = 2;
export const FDFLAG_NONBLOCK = 4;
export const FDFLAG_RSYNC = 8;
export const FDFLAG_SYNC = 16;

const SYNCHRONOUS = FDFLAG_DSYNC | FDFLAG_RSYNC | FDFLAG_SYNC;
export const FDFLAGS_MASK = FDFLAG_APPEND | FDFLAG_NONBLOCK | SYNCHRONOUS;

export function descriptorFlagError(flags: number, current = 0): 0 | 28 | 58 {
  if (flags & ~FDFLAGS_MASK) return 28;
  if ((flags ^ current) & SYNCHRONOUS) return 58;
  return 0;
}
