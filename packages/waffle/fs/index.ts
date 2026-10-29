export {
  FilesystemClient,
  FilesystemCompletion,
  type FilesystemClientOptions,
  resolveWriteFileMode,
  type WriteFileOptions,
  type WriteFileMode,
} from "./client.js";
export { FilesystemService, installFilesystemWorker } from "./service.js";
export { FilesystemTransportError, FILESYSTEM_REQUEST_LIMITS } from "./request-memory.js";
export { MemoryBackend, type FilesystemBackend } from "./backend.js";
export {
  createFilesystemConnection,
  createFilesystemIdentity,
  createProcessFilesystemIdentity,
  releaseFilesystemReservation,
  connectFilesystemIdentity,
  revokeFilesystemService,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
  type FilesystemIdentity,
  type FilesystemReservation,
  type FilesystemConnection,
  FilesystemError,
} from "./protocol.js";

export {
  DEFAULT_SHARED_MAX_BYTES,
  SHARED_SEGMENT_BYTES,
  MissingSegmentError,
  MissingDataError,
  SharedFilesystemState,
  sharedRevoked,
  type SharedFileInfo,
} from "./shared.js";

export { PersistentBackend } from "./persistent.js";
export { IndexedDBStorage } from "./indexeddb.js";
export { OpfsStorage, type OpfsStorageOptions } from "./opfs.js";
export type { StorageBackend, PersistedIndex, PersistedNode, PersistenceBatch } from "./storage.js";

export { getVfsDescriptor, VfsError } from "./vfs.js";
export type { VfsMode, VfsDescriptor, VfsSelection, VfsWhenBusy, VfsErrorCode } from "./vfs.js";

export * from "./workspace.js";

export {
  createWorkspaceSearch,
  WORKSPACE_SEARCH_LIMITS,
  type SearchQuery,
  type SearchHit,
  type IndexStamp,
  type SearchTerminal,
  type SearchPage,
  type IndexValidation,
  type SearchCursor,
  type WorkspaceSearch,
  type SearchLimits,
} from "./workspace-search.js";

export {
  exportWorkspaceArchive,
  WorkspaceExportError,
  WORKSPACE_EXPORT_LIMITS,
  type WorkspaceExportOptions,
  type ExportRefusal,
} from "./workspace-export.js";
export { WorkspaceArchiveError } from "./workspace-archive.js";

export { FilesystemWatch, type WatchOptions, type WatchEvent, type WatchBatch } from "./watch.js";
