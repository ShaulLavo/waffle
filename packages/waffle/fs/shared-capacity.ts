// Package trees reserve 64 KiB pages. Leave headroom beyond a retained 1 GiB tree
// while keeping the allocator metadata and first segment inside the 64 MiB root.
export const DEFAULT_SHARED_MAX_BYTES = 1536 * 1024 * 1024;
export const SHARED_SEGMENT_BYTES = 16 * 1024 * 1024;
export const MAX_SHARED_SEGMENTS = DEFAULT_SHARED_MAX_BYTES / SHARED_SEGMENT_BYTES;
export const PAGE = 64 * 1024;
// File sizes occupy signed 32-bit slots. More aggregate storage need not enlarge files.
export const MAX_SHARED_FILE_BYTES = 1024 * 1024 * 1024;
