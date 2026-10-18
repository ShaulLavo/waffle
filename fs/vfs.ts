/** Only certified, existing implementations are selectable. Settings do not name VFSs. */
export type VfsName = "indexeddb" | "opfs-memory" | "memory";
export type VfsWhenBusy = "takeover" | "wait";
export type VfsSelection =
  | { vfs?: "indexeddb"; whenBusy?: VfsWhenBusy }
  | { vfs: "opfs-memory"; whenBusy?: "wait" }
  | { vfs: "memory"; whenBusy?: never };

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
  readonly id: VfsName;
  readonly displayName: string;
  readonly persistent: boolean;
  readonly mutationAcknowledgement: "memory";
  /** Browser storage completion, not protection from eviction or site-data deletion. */
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
  /** Capability description only; live state is filesystem.state. */
  readonly lifecycle: readonly ("opening" | "waiting" | "ready" | "failed" | "disposed")[];
}

const requirements = ["SharedArrayBuffer", "cross-origin-isolation", "dedicated-worker"];
const persistent = {
  mutationAcknowledgement: "memory",
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

const descriptors: Record<VfsName, VfsDescriptor> = {
  indexeddb: Object.freeze({
    ...persistent,
    id: "indexeddb",
    displayName: "IndexedDB",
    supportedWhenBusy: Object.freeze(["takeover", "wait"] as const),
    defaultWhenBusy: "takeover",
    requirements: Object.freeze(requirements.concat(["IndexedDB", "Web Locks"])),
    format: Object.freeze({
      id: "waffle-indexeddb-v1",
      location: "IndexedDB database named by filesystem.name (default waffle-workspace)",
    }),
    unsupportedSettings: Object.freeze([]),
  }),
  "opfs-memory": Object.freeze({
    ...persistent,
    id: "opfs-memory",
    displayName: "OPFS (memory-first)",
    supportedWhenBusy: Object.freeze(["wait"] as const),
    defaultWhenBusy: "wait",
    requirements: Object.freeze(requirements.concat(["OPFS", "sync-access-handles", "Web Locks"])),
    format: Object.freeze({
      id: "waffle-opfs-snapshots-v1",
      location: "OPFS bun-wasm-<base64url(JSON(workspace name))>/{data,metadata}",
    }),
    unsupportedSettings: Object.freeze(["whenBusy:takeover"]),
  }),
  memory: Object.freeze({
    ...persistent,
    id: "memory",
    displayName: "Memory (nonpersistent)",
    persistent: false,
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

/** Unknown names, including future VFSs, are errors, never fallbacks. */
export function getVfsDescriptor(name: string = "indexeddb"): VfsDescriptor {
  if (name === "indexeddb" || name === "opfs-memory" || name === "memory") return descriptors[name];
  throw new VfsError("UNSUPPORTED_VFS", String(name), `Unsupported VFS: ${String(name)}`);
}

/** Validate on both sides of worker startup; JavaScript callers are not constrained by TS. */
export function resolveVfs(options: { vfs?: unknown; whenBusy?: unknown }): {
  descriptor: VfsDescriptor;
  whenBusy?: VfsWhenBusy;
} {
  const descriptor = getVfsDescriptor(
    options.vfs === undefined ? "indexeddb" : String(options.vfs),
  );
  const whenBusy = options.whenBusy;
  if (whenBusy === undefined) return { descriptor, whenBusy: descriptor.defaultWhenBusy };
  if (
    (whenBusy === "wait" || whenBusy === "takeover") &&
    descriptor.supportedWhenBusy.includes(whenBusy)
  )
    return { descriptor, whenBusy };
  throw new VfsError(
    "INVALID_VFS_SETTINGS",
    descriptor.id,
    `${descriptor.id} does not support whenBusy: ${String(whenBusy)}`,
  );
}

/** No probe or storage mutation: only verify the APIs needed by the existing implementation. */
export function requireVfsCapabilities(name: VfsName): void {
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
