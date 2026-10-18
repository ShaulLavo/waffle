import { INDEXEDDB_FORMAT, OPFS_FORMAT } from "./vfs-format.js";
import type { VfsImplementation } from "./vfs-internal.js";

/** @public Product guarantees, independent of the browser's physical storage adapter. */
export type VfsMode = "fast" | "safe" | "memory";
export type VfsWhenBusy = "takeover" | "wait";
export type VfsSelection =
  | { mode?: "fast" | "safe"; whenBusy?: VfsWhenBusy }
  | { mode: "memory"; whenBusy?: never };

export type VfsErrorCode =
  | "UNSUPPORTED_VFS"
  | "INVALID_VFS_SETTINGS"
  | "UNSUPPORTED_VFS_CAPABILITY"
  | "INVALID_VFS_FORMAT";

/** Stable across the filesystem worker boundary, including startup failures. */
export class VfsError extends Error {
  override readonly name = "VfsError";
  constructor(
    readonly code: VfsErrorCode,
    readonly vfs: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VfsDescriptor {
  readonly mode: VfsMode;
  /** Inspectable result, not a public selector. No automatic store switch or migration. */
  readonly implementation: VfsImplementation;
  readonly displayName: string;
  readonly persistent: boolean;
  readonly mutationAcknowledgement: "memory";
  readonly durabilityPoint: "completed-durable-checkpoint" | "none";
  readonly lossBound: "changes-after-last-completed-durable-checkpoint" | "all-changes";
  /** Current engines do not yet implement the approved bounded multi-writer engine. */
  readonly pendingDataBound: "not-yet-enforced" | "runtime-memory";
  readonly durability: {
    readonly flush: "checkpoint-data-and-metadata" | "volatile-ordering-only";
    readonly fsync: "targeted-file-checkpoint" | "volatile-ordering-only";
    readonly targetedFlush: "selected-payloads-and-namespace" | "volatile-ordering-only";
  };
  readonly multiTab: "exclusive-owner" | "isolated";
  readonly supportedWhenBusy: readonly VfsWhenBusy[];
  readonly defaultWhenBusy?: VfsWhenBusy;
  readonly requirements: readonly string[];
  readonly worker: "dedicated";
  readonly serviceMayAwait: true;
  readonly directSharedMemory: { readonly reads: true; readonly mutations: true };
  readonly format: { readonly id: string; readonly location: string } | null;
  readonly unsupportedSettings: readonly string[];
  readonly lifecycle: readonly ("opening" | "waiting" | "ready" | "failed" | "disposed")[];
}

const requirements = ["SharedArrayBuffer", "cross-origin-isolation", "dedicated-worker"];
const persistent = {
  mode: "fast",
  mutationAcknowledgement: "memory",
  durabilityPoint: "completed-durable-checkpoint",
  lossBound: "changes-after-last-completed-durable-checkpoint",
  pendingDataBound: "not-yet-enforced",
  durability: Object.freeze({
    flush: "checkpoint-data-and-metadata",
    fsync: "targeted-file-checkpoint",
    targetedFlush: "selected-payloads-and-namespace",
  }),
  multiTab: "exclusive-owner",
  worker: "dedicated",
  serviceMayAwait: true,
  directSharedMemory: Object.freeze({ reads: true, mutations: true }),
  persistent: true,
  lifecycle: Object.freeze(["opening", "waiting", "ready", "failed", "disposed"] as const),
} as const;

const descriptors: Record<VfsImplementation, VfsDescriptor> = {
  indexeddb: Object.freeze({
    ...persistent,
    implementation: "indexeddb",
    displayName: "FAST (IndexedDB checkpoints)",
    supportedWhenBusy: Object.freeze(["takeover", "wait"] as const),
    defaultWhenBusy: "takeover",
    requirements: Object.freeze(requirements.concat(["IndexedDB", "Web Locks"])),
    format: Object.freeze({
      id: INDEXEDDB_FORMAT,
      location: "IndexedDB database named by filesystem.name (default waffle-workspace)",
    }),
    unsupportedSettings: Object.freeze([]),
  }),
  "opfs-memory": Object.freeze({
    ...persistent,
    implementation: "opfs-memory",
    displayName: "FAST (OPFS checkpoints)",
    supportedWhenBusy: Object.freeze(["wait"] as const),
    defaultWhenBusy: "wait",
    requirements: Object.freeze(requirements.concat(["OPFS", "sync-access-handles", "Web Locks"])),
    format: Object.freeze({
      id: OPFS_FORMAT,
      location: "OPFS bun-wasm-<base64url(JSON(workspace name))>/{data,metadata}",
    }),
    unsupportedSettings: Object.freeze(["whenBusy:takeover"]),
  }),
  memory: Object.freeze({
    ...persistent,
    mode: "memory",
    implementation: "memory",
    displayName: "Memory (nonpersistent)",
    persistent: false,
    durabilityPoint: "none",
    lossBound: "all-changes",
    pendingDataBound: "runtime-memory",
    durability: Object.freeze({
      flush: "volatile-ordering-only",
      fsync: "volatile-ordering-only",
      targetedFlush: "volatile-ordering-only",
    }),
    multiTab: "isolated",
    supportedWhenBusy: Object.freeze([]),
    requirements: Object.freeze(requirements),
    format: null,
    unsupportedSettings: Object.freeze(["whenBusy"]),
    lifecycle: Object.freeze(["opening", "ready", "failed", "disposed"] as const),
  }),
};

/** FAST preserves the existing IndexedDB workspace in every browser until a migration wins. */
export function getVfsDescriptor(mode: string = "fast"): VfsDescriptor {
  if (mode === "fast") return descriptors.indexeddb;
  if (mode === "memory") return descriptors.memory;
  throw new VfsError("UNSUPPORTED_VFS", String(mode), `Unsupported VFS mode: ${String(mode)}`);
}

/** The second argument is an internal conformance override, never a public product setting. */
export function resolveVfs(
  options: { mode?: unknown; whenBusy?: unknown },
  implementation?: unknown,
): { descriptor: VfsDescriptor; whenBusy?: VfsWhenBusy } {
  if ("vfs" in options || "storage" in options || "persistence" in options)
    throw new VfsError(
      "INVALID_VFS_SETTINGS",
      String(options.mode ?? "fast"),
      "Select a filesystem mode, not a backend",
    );
  const selected = getVfsDescriptor(options.mode === undefined ? "fast" : String(options.mode));
  const descriptor = overrideDescriptor(selected, implementation);
  const whenBusy = options.whenBusy;
  if (whenBusy === undefined) return { descriptor, whenBusy: descriptor.defaultWhenBusy };
  if (
    (whenBusy === "wait" || whenBusy === "takeover") &&
    descriptor.supportedWhenBusy.includes(whenBusy)
  )
    return { descriptor, whenBusy };
  throw new VfsError(
    "INVALID_VFS_SETTINGS",
    descriptor.implementation,
    `${descriptor.implementation} does not support whenBusy: ${String(whenBusy)}`,
  );
}

function overrideDescriptor(selected: VfsDescriptor, implementation: unknown): VfsDescriptor {
  if (implementation === undefined) return selected;
  if (
    implementation !== "indexeddb" &&
    implementation !== "opfs-memory" &&
    implementation !== "memory"
  )
    throw new VfsError(
      "UNSUPPORTED_VFS",
      String(implementation),
      `Unsupported VFS implementation: ${String(implementation)}`,
    );
  const descriptor = descriptors[implementation];
  if (descriptor.mode !== selected.mode)
    throw new VfsError(
      "INVALID_VFS_SETTINGS",
      implementation,
      "Implementation does not implement the selected mode",
    );
  return descriptor;
}

/** No probe or storage mutation: only verify the APIs needed by the existing implementation. */
export function requireVfsCapabilities(name: VfsImplementation): void {
  if (name === "memory") return;
  const locks = globalThis.navigator?.locks;
  const hasStorage = name === "indexeddb" ? !!globalThis.indexedDB : hasOpfs();
  if (locks && hasStorage) return;
  throw new VfsError(
    "UNSUPPORTED_VFS_CAPABILITY",
    name,
    `${name} requires ${name === "indexeddb" ? "IndexedDB" : "OPFS sync access handles"} and Web Locks in a dedicated worker`,
  );
}
function hasOpfs(): boolean {
  return (
    typeof globalThis.navigator?.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    typeof (
      FileSystemFileHandle.prototype as FileSystemFileHandle & { createSyncAccessHandle?: unknown }
    ).createSyncAccessHandle === "function"
  );
}
