/** Host-provided identity for this runtime, not identity discovered from the browser. */
export interface RuntimeHostIdentity {
  readonly uid: number;
  readonly euid: number;
  readonly hostname: string;
}

export interface RuntimeProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly host: RuntimeHostIdentity | null;
}

/** Missing host identity is unsupported, never an implicit root or localhost. */
export function snapshotHostIdentity(
  identity: RuntimeHostIdentity | null | undefined,
): RuntimeHostIdentity | null {
  if (identity === null || identity === undefined) return null;
  const { uid, euid, hostname } = identity;
  for (const value of [uid, euid]) {
    if (!Number.isInteger(value) || value < 0 || value >= 0xffff_ffff)
      throw new TypeError("Host UID and EUID must be unsigned IDs below 4294967295");
  }
  if (
    typeof hostname !== "string" ||
    !hostname.length ||
    Array.from(hostname, (character) => character.charCodeAt(0)).some(
      (code) => code <= 32 || code === 127,
    )
  )
    throw new TypeError("Host hostname must be nonempty and contain no whitespace or controls");
  return Object.freeze({ uid, euid, hostname });
}

/** Process ancestry comes from the runtime process table or its shared worker transport. */
export function createProcessIdentity(
  process: Pick<RuntimeProcessIdentity, "pid" | "parentPid">,
  host?: RuntimeHostIdentity | null,
): RuntimeProcessIdentity;
export function createProcessIdentity(
  process: Pick<RuntimeProcessIdentity, "pid" | "parentPid"> | null,
  host?: RuntimeHostIdentity | null,
): RuntimeProcessIdentity | null;
export function createProcessIdentity(
  process: Pick<RuntimeProcessIdentity, "pid" | "parentPid"> | null,
  host?: RuntimeHostIdentity | null,
): RuntimeProcessIdentity | null {
  if (process === null) return null;
  const { pid, parentPid } = process;
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff)
    throw new TypeError("Process PID must be a positive signed 32-bit ID");
  if (!Number.isInteger(parentPid) || parentPid < 0 || parentPid > 0x7fff_ffff || parentPid === pid)
    throw new TypeError("Process parent PID must be a different nonnegative signed 32-bit ID");
  return Object.freeze({ pid, parentPid, host: snapshotHostIdentity(host) });
}
