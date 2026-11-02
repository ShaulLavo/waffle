export { createRuntime } from "./runtime.js";
export type {
  NetConnect,
  NetConnectErrorCode,
  NetOutboundStream,
  NetOutboundTarget,
} from "./browser/net/outbound.js";
export { RuntimeNetworkLookupError } from "./runtime.js";
export type {
  Runtime,
  RuntimeOptions,
  RuntimeNetwork,
  RuntimeNetworkHelper,
  RuntimeNetworkPathScope,
  RuntimeNetworkLookupErrorCode,
  RuntimeNetworkLookupOptions,
  RuntimeNetworkLookupResult,
  RuntimeFilesystem,
  RuntimeSupervisor,
  RuntimeConsumer,
  ProcessService,
  RootDescendantPreparation,
  RootPreparationCompletion,
  WorkerMemoryObservation,
  ProgramDefinition,
  ProgramLoadState,
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
  RemoveCondition,
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

export type {
  RuntimePrograms,
  ProgramHandle,
  ProgramState,
  ProgramMode,
  ProgramsOptions,
} from "./programs/collection.js";

export {
  openWorkspaceRead,
  WorkspaceReadContractError,
  type WorkspaceReadStream,
  type WorkspaceReadStep,
} from "./fs/workspace-stream.js";

export { CommandStdioError } from "./proc/command.js";
export type {
  HostCommand,
  HostCommandDefinition,
  HostCommandContext,
  CommandInput,
  CommandOutput,
  ProcessQuery,
  CommandProcessRow,
  SignalSend,
  DelegatedSignals,
} from "./proc/command.js";
export type { CommandProcessContext } from "./proc/types.js";

export type { SignalDelegation } from "./programs/index.js";
