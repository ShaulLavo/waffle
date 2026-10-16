export { FilesystemClient, FilesystemCompletion } from "./client";
export { FilesystemService, installFilesystemWorker } from "./service";
export { MemoryBackend, type FilesystemBackend } from "./backend";
export { createFilesystemConnection, createFilesystemIdentity, connectFilesystemIdentity, revokeFilesystem, reapFilesystem, waitForFilesystemQuiescence, type FilesystemIdentity, type FilesystemConnection, FilesystemError } from "./protocol";

export { DEFAULT_SHARED_MAX_BYTES, SHARED_SEGMENT_BYTES, MissingSegmentError, SharedFilesystemState, sharedRevoked, type SharedFileInfo } from "./shared";
