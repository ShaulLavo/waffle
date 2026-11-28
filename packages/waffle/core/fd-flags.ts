export const FDFLAG_APPEND = 1;
const FDFLAG_DSYNC = 2;
export const FDFLAG_NONBLOCK = 4;
const FDFLAG_RSYNC = 8;
const FDFLAG_SYNC = 16;

const SYNCHRONOUS = FDFLAG_DSYNC | FDFLAG_RSYNC | FDFLAG_SYNC;
const KNOWN = FDFLAG_APPEND | FDFLAG_NONBLOCK | SYNCHRONOUS;

export function descriptorFlagError(flags: number): 0 | 28 | 58 {
  if (flags & ~KNOWN) return 28;
  if (flags & SYNCHRONOUS) return 58;
  return 0;
}
