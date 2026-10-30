import type { FilesystemIdentity } from "../fs/protocol.js";
import { SLOT_WORDS, SharedFilesystemState } from "../fs/shared.js";

// Shared-slot field and global-lock cell of fs/shared.ts, read only to audit lock words.
const FILE_LOCK = 8;
const GLOBAL_LOCK = 1;

export function auditFilesystem(identity: FilesystemIdentity) {
  const revocation = Atomics.load(new Int32Array(identity.revocations[0]!), 0);
  const sections = Atomics.load(new Int32Array(identity.sections), 0);
  const state = new SharedFilesystemState(identity.shared, identity.maxBytes);
  let fileLocks = 0;
  for (let slot = 1; slot < state.slots.length / SLOT_WORDS; slot++)
    if (Atomics.load(state.slots, slot * SLOT_WORDS + FILE_LOCK) === identity.owner) fileLocks++;
  return {
    sections,
    revocation,
    fileLocks,
    globalLock: Atomics.load(state.cells, GLOBAL_LOCK) === identity.owner,
  };
}

function check(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

export function assertFilesystemStopped(
  snapshot: Readonly<ReturnType<typeof auditFilesystem>>,
  label: string,
): void {
  check(snapshot.revocation !== 0, `${label}: stopped with its filesystem unrevoked`);
  check(snapshot.sections === 0, `${label}: stopped inside ${snapshot.sections} sections`);
  check(snapshot.fileLocks === 0, `${label}: dead token holds ${snapshot.fileLocks} file locks`);
  check(!snapshot.globalLock, `${label}: dead token holds the global lock`);
}

export function assertFilesystemQuiet(identity: FilesystemIdentity, label: string): void {
  const snapshot = auditFilesystem(identity);
  check(snapshot.revocation !== 0, `${label}: filesystem unrevoked after stop`);
  check(
    snapshot.fileLocks === 0,
    `${label}: a helper took ${snapshot.fileLocks} file locks after stop`,
  );
  check(!snapshot.globalLock, `${label}: a helper took the global lock after stop`);
}
