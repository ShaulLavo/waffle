export { FilesystemClient, FilesystemCompletion } from "./client.js";
export { FilesystemService, installFilesystemWorker } from "./service.js";
export { MemoryBackend, type FilesystemBackend } from "./backend.js";
export { createFilesystemConnection, createFilesystemIdentity, createProcessFilesystemIdentity, releaseFilesystemReservation, connectFilesystemIdentity, revokeFilesystemService, revokeFilesystem, reapFilesystem, waitForFilesystemQuiescence, type FilesystemIdentity, type FilesystemReservation, type FilesystemConnection, FilesystemError } from "./protocol.js";

export { DEFAULT_SHARED_MAX_BYTES, SHARED_SEGMENT_BYTES, MissingSegmentError, MissingDataError, SharedFilesystemState, sharedRevoked, type SharedFileInfo } from "./shared.js";

export { PersistentBackend } from "./persistent.js";
export { IndexedDBStorage } from "./indexeddb.js";
export { OpfsStorage, type OpfsStorageOptions } from "./opfs.js";
export type { StorageBackend, PersistedIndex, PersistedNode, PersistenceBatch } from "./storage.js";
