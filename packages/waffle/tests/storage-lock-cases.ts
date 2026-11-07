export type StorageLockBackend = "opfs" | "indexeddb";
export type StorageLockScenario =
  | {
      kind:
        | "contested"
        | "earlyReload"
        | "crashedOwner"
        | "cancelWhileWaiting"
        | "fifoWaiters"
        | "guestWork"
        | "opfsTakeoverRejected";
    }
  | { kind: "takeover"; policy: "default" | "takeover" }
  | { kind: "recovery"; timing: "disposing" | "recovering" | "ready" }
  | { kind: "lateRecoveryPublication" };
export type StorageLockCase = {
  ordinal: number;
  backend: StorageLockBackend;
  label: string;
  id: string;
  scenario: StorageLockScenario;
};
export const storageLockCases: readonly StorageLockCase[] = [
  {
    ordinal: 1,
    backend: "opfs",
    label: "contested open waits and reads flushed data",
    id: "opfs: contested open waits and reads flushed data",
    scenario: { kind: "contested" },
  },
  {
    ordinal: 2,
    backend: "opfs",
    label: "early reload after owner close becomes ready",
    id: "opfs: early reload after owner close becomes ready",
    scenario: { kind: "earlyReload" },
  },
  {
    ordinal: 3,
    backend: "opfs",
    label: "crashed owner releases lock to waiter",
    id: "opfs: crashed owner releases lock to waiter",
    scenario: { kind: "crashedOwner" },
  },
  {
    ordinal: 4,
    backend: "opfs",
    label: "dispose while waiting removes queued request",
    id: "opfs: dispose while waiting removes queued request",
    scenario: { kind: "cancelWhileWaiting" },
  },
  {
    ordinal: 5,
    backend: "opfs",
    label: "several waiters acquire ownership FIFO",
    id: "opfs: several waiters acquire ownership FIFO",
    scenario: { kind: "fifoWaiters" },
  },
  {
    ordinal: 6,
    backend: "opfs",
    label: "guest work remains pending until ownership",
    id: "opfs: guest work remains pending until ownership",
    scenario: { kind: "guestWork" },
  },
  {
    ordinal: 7,
    backend: "indexeddb",
    label: "contested open waits and reads flushed data",
    id: "indexeddb: contested open waits and reads flushed data",
    scenario: { kind: "contested" },
  },
  {
    ordinal: 8,
    backend: "indexeddb",
    label: "early reload after owner close becomes ready",
    id: "indexeddb: early reload after owner close becomes ready",
    scenario: { kind: "earlyReload" },
  },
  {
    ordinal: 9,
    backend: "indexeddb",
    label: "crashed owner releases lock to waiter",
    id: "indexeddb: crashed owner releases lock to waiter",
    scenario: { kind: "crashedOwner" },
  },
  {
    ordinal: 10,
    backend: "indexeddb",
    label: "dispose while waiting removes queued request",
    id: "indexeddb: dispose while waiting removes queued request",
    scenario: { kind: "cancelWhileWaiting" },
  },
  {
    ordinal: 11,
    backend: "indexeddb",
    label: "several waiters acquire ownership FIFO",
    id: "indexeddb: several waiters acquire ownership FIFO",
    scenario: { kind: "fifoWaiters" },
  },
  {
    ordinal: 12,
    backend: "indexeddb",
    label: "guest work remains pending until ownership",
    id: "indexeddb: guest work remains pending until ownership",
    scenario: { kind: "guestWork" },
  },
  {
    ordinal: 13,
    backend: "indexeddb",
    label: "default takeover still fences the old owner",
    id: "indexeddb: default takeover still fences the old owner",
    scenario: { kind: "takeover", policy: "default" },
  },
  {
    ordinal: 14,
    backend: "indexeddb",
    label: "explicit takeover still fences the old owner",
    id: "indexeddb: explicit takeover still fences the old owner",
    scenario: { kind: "takeover", policy: "takeover" },
  },
  {
    ordinal: 15,
    backend: "opfs",
    label: "takeover is rejected for OPFS",
    id: "opfs: takeover is rejected for OPFS",
    scenario: { kind: "opfsTakeoverRejected" },
  },
  {
    ordinal: 16,
    backend: "indexeddb",
    label: "ownership loss during gated recovery acknowledges disposal",
    id: "indexeddb: ownership loss during gated recovery acknowledges disposal",
    scenario: { kind: "recovery", timing: "disposing" },
  },
  {
    ordinal: 17,
    backend: "indexeddb",
    label: "ownership loss during gated recovery fails without disposal",
    id: "indexeddb: ownership loss during gated recovery fails without disposal",
    scenario: { kind: "recovery", timing: "recovering" },
  },
  {
    ordinal: 18,
    backend: "indexeddb",
    label: "ownership loss after gated recovery retains failed cleanup owner",
    id: "indexeddb: ownership loss after gated recovery retains failed cleanup owner",
    scenario: { kind: "recovery", timing: "ready" },
  },
  {
    ordinal: 19,
    backend: "indexeddb",
    label: "ownership loss before recovered backend publication rejects startup",
    id: "indexeddb: ownership loss before recovered backend publication rejects startup",
    scenario: { kind: "lateRecoveryPublication" },
  },
];
