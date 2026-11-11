import {
  DEFAULT_SHARED_MAX_BYTES,
  MAX_SHARED_FILE_BYTES,
  SHARED_SEGMENT_BYTES,
} from "./shared-capacity.js";

export const DATA_PAGE_BYTES = 4 * 1024;
export const DATA_PAGES_PER_SEGMENT = SHARED_SEGMENT_BYTES / DATA_PAGE_BYTES;
export const TOTAL_DATA_PAGES = DEFAULT_SHARED_MAX_BYTES / DATA_PAGE_BYTES;
export const MAX_FILE_PAGES = MAX_SHARED_FILE_BYTES / DATA_PAGE_BYTES;
export const TABLE_ENTRIES = 64;
export const DIRECT_LEAVES = 7;
export const FILE_ROOT_WORDS = DIRECT_LEAVES + 1;
export const MAX_FILES = 32768;
const TAIL_FILES = Math.floor(TOTAL_DATA_PAGES / (DIRECT_LEAVES * TABLE_ENTRIES + 1));
// One partial leaf per file plus full leaves for the pool, and a top and branches per tail file.
export const TABLE_BLOCKS =
  MAX_FILES +
  Math.ceil(TOTAL_DATA_PAGES / TABLE_ENTRIES) +
  2 * TAIL_FILES +
  Math.ceil(TOTAL_DATA_PAGES / TABLE_ENTRIES ** 2);
// Blocks come first so a missing block computes a negative index instead of a live root cell.
export const ROOT_CELL_BASE = TABLE_BLOCKS * TABLE_ENTRIES;
export const PAGE_CELLS = ROOT_CELL_BASE + MAX_FILES * FILE_ROOT_WORDS;
export const SLOT_WORDS = 24;
const DIRTY_HEADER_WORDS = 48;
export const HEADER_WORDS = 32 + DIRTY_HEADER_WORDS;
export const WATCH_CAPACITY = 128;
export const WATCH_RECORD_WORDS = 288;
export const WATCH_BYTES = (4 + WATCH_CAPACITY * WATCH_RECORD_WORDS) * 4;
export const SLOT_OFFSET = HEADER_WORDS + TOTAL_DATA_PAGES;
export const TABLE_OWNER_OFFSET = SLOT_OFFSET + MAX_FILES * SLOT_WORDS;
export const PAGE_CELL_OFFSET = TABLE_OWNER_OFFSET + TABLE_BLOCKS;
export const WATCH_OFFSET = (PAGE_CELL_OFFSET + PAGE_CELLS) * 4;
export const DATA_OFFSET = WATCH_OFFSET + WATCH_BYTES;
export const SHARED_ROOT_BYTES = DATA_OFFSET + SHARED_SEGMENT_BYTES;
