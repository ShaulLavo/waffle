/** Wire constants shared by the page-side group owner and each member's worker. */

export const PAGE_BYTES = 65536;
/** The wasm32 address space: 4 GiB. */
export const MAX_GROUP_PAGES = 65536;

/** Negative WASI errno results returned by runtime_shm imports. */
export const GroupErrno = Object.freeze({
  AGAIN: 6,
  BADF: 8,
  INVAL: 28,
  NOMEM: 48,
  SRCH: 71,
});

/** Member-to-owner requests. Each carries a sequence number and up to three u32 arguments. */
export const GroupOp = Object.freeze({
  GROW: 1,
  CREATE: 2,
  ATTACH: 3,
  DETACH: 4,
  PIN: 5,
  ROUTE: 6,
  ACCEPT: 7,
  UNPIN: 8,
});

export interface GroupRequestMessage {
  readonly seq: number;
  readonly op: number;
  readonly args: readonly [number, number, number];
}

/** Reply cells: [seq, status, r0, r1, r2]. The owner stores results before publishing seq. */
export const REPLY_WORDS = 5;

/**
 * Watch table in the control buffer. Owned by the group owner, never guest memory.
 * Header word 0 is the registration sequence. Each slot is four i32 words:
 * state (0 free, (member + 1) << 1 claimed, | 1 live), address, registration sequence,
 * wake generation. Members claim and release only their own slots. The owner clears a
 * stopped member's slots before its index can be admitted again.
 */
export const WATCH_HEADER_WORDS = 4;
export const WATCH_SLOT_WORDS = 4;

export function controlBytes(watches: number): number {
  return (WATCH_HEADER_WORDS + watches * WATCH_SLOT_WORDS) * 4;
}

/** Broker-owned request field for one member incarnation. Never part of a guest-built request. */
export interface MemoryGroupMemberRequest {
  readonly memory: WebAssembly.Memory;
  readonly control: SharedArrayBuffer;
  readonly reply: SharedArrayBuffer;
  readonly port: MessagePort;
  /** Member slot, stable for this incarnation; watch ownership uses it. */
  readonly index: number;
  readonly watches: number;
  /** W2 reported parallelism for the group. */
  readonly parallelism: number;
  /** Bytes of private stack carved for a PIE image. */
  readonly stackBytes: number;
}
