export { Wasi, WasiExit, type WasiOptions } from "./wasi.js";
export {
  DescriptorTable,
  OpenDescription,
  type Descriptor,
  type Resource,
  type Stream,
  type Readiness,
} from "./descriptors.js";
export type {
  FileSystem,
  FileHandle,
  FileStat,
  FilePermissions,
  DirectoryEntry,
  ResolvedPath,
} from "./filesystem.js";
export { memoryViews, type MemoryViews } from "./memory-views.js";
export { shareFileResource, withFileOffset } from "./open-file.js";
export { normalize, splitPath, dirname, basename } from "./path.js";
