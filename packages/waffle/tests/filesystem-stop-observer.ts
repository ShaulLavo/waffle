import type { FilesystemIdentity } from "../fs/protocol.js";
import { SLOT_WORDS, SharedFilesystemState } from "../fs/shared.js";

// Shared-slot field and global-lock cell of fs/shared.ts, read only to audit lock words.
const FILE_LOCK = 8;
const GLOBAL_LOCK = 1;

export function auditFilesystem(identity: FilesystemIdentity) {
  const state = new SharedFilesystemState(identity.shared, identity.maxBytes);
  let fileLocks = 0;
  for (let slot = 1; slot < state.slots.length / SLOT_WORDS; slot++)
    if (Atomics.load(state.slots, slot * SLOT_WORDS + FILE_LOCK) === identity.owner) fileLocks++;
  return {
    sections: Atomics.load(new Int32Array(identity.sections), 0),
    revocation: Atomics.load(new Int32Array(identity.revocations[0]!), 0),
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
  check(snapshot.sections === 0, `${label}: stopped inside ${snapshot.sections} sections`);
  check(snapshot.fileLocks === 0, `${label}: dead token holds ${snapshot.fileLocks} file locks`);
  check(!snapshot.globalLock, `${label}: dead token holds the global lock`);
}

export function assertFilesystemQuiet(identity: FilesystemIdentity, label: string): void {
  check(
    Atomics.load(new Int32Array(identity.sections), 0) === 0,
    `${label}: a helper entered a section after stop`,
  );
}
