export { createRuntime } from "./runtime.js";
export type {
  Runtime,
  RuntimeOptions,
  RuntimeNetwork,
  RuntimeNetworkHelper,
  RuntimeFilesystem,
  RuntimeSupervisor,
  RuntimeConsumer,
  ProcessService,
  ProgramDefinition,
  GuestLauncher,
  RuntimeHostIdentity,
  RuntimeProcessIdentity,
  RuntimeProcessContext,
  ProcessAdmissionEvent,
  ProcessAdmissionObserver,
  RuntimeStartupStage,
  RuntimeStartupObserver,
} from "./runtime.js";
export type {
  SharedFilesystemOptions,
  SharedFilesystemState,
  SharedFilesystemStatus,
  SharedFilesystemStateObserver,
} from "./browser/shared-fs.js";

export { getVfsDescriptor, VfsError } from "./fs/vfs.js";
export type { VfsMode, VfsDescriptor, VfsSelection, VfsWhenBusy, VfsErrorCode } from "./fs/vfs.js";

export type {
  WorkspaceVfs,
  ByteRange,
  FileTarget,
  VersionStat,
  ReadValue,
  ReadOutcome,
  ReadFailure,
  ReadResource,
  VersionLease,
  SnapshotOptions,
  SnapshotCursor,
  SnapshotPage,
  NamespaceEntry,
  NamespaceCut,
  Watermark,
  Generation,
  ChangeSeq,
  FileId,
  FileVersion,
  WorkspaceChange,
  ChangeBatch,
  WorkspaceChangePage,
  WorkspaceTerminal,
  WorkspacePressure,
  HistoryGap,
} from "./fs/workspace.js";

export {
  exportWorkspaceArchive,
  WorkspaceExportError,
  WORKSPACE_EXPORT_LIMITS,
  type WorkspaceExportOptions,
  type ExportRefusal,
} from "./fs/workspace-export.js";
export { WorkspaceArchiveError } from "./fs/workspace-archive.js";
