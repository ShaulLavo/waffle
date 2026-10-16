export { Wasi, WasiExit, type WasiOptions } from "./wasi";
export { DescriptorTable, OpenDescription, type Descriptor, type Resource, type Stream, type Readiness } from "./descriptors";
export type { FileSystem, FileHandle, FileStat, DirectoryEntry, ResolvedPath } from "./filesystem";
export { memoryViews, type MemoryViews } from "./memory-views.js";
export { normalize, splitPath, dirname, basename } from "./path";
