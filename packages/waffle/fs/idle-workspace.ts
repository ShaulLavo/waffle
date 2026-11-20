export interface StoredWorkspaceSelection {
  readonly mode: "fast";
  readonly name: string;
}

export interface IdleWorkspace {
  walk(path?: string, options?: IdleWorkspaceWalkOptions): IdleWorkspaceWalk;
  listFiles(path: string): Promise<string[]>;
  readFile(path: string, options?: IdleWorkspaceReadOptions): Promise<Uint8Array | undefined>;
  delete(): Promise<void>;
  close(): Promise<void>;
}

export interface StoredWorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink" | "socket";
  readonly ino: number;
  readonly nlink: number;
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly target?: string;
}
export interface IdleWorkspacePage {
  readonly entries: readonly StoredWorkspaceEntry[];
  readonly done: boolean;
}
export interface IdleWorkspaceWalk {
  next(): Promise<IdleWorkspacePage>;
  close(): Promise<void>;
}
export interface IdleWorkspaceReadOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}
export interface IdleWorkspaceWalkOptions {
  readonly signal?: AbortSignal;
  readonly ignoreRoots?: readonly string[];
}

export async function storedWorkspaces(mode: "fast"): Promise<string[]> {
  if (mode !== "fast") throw new TypeError("Stored workspaces require fast mode");
  const { storedNames } = await import("./idle-database.js");
  return storedNames();
}

/** Deletes the named workspace from IndexedDB and OPFS without reading its records, so a
 * workspace that no longer opens, for example one saved in an older format, can start fresh.
 * A workspace another tab or idle handle holds is left alone: the result is then "busy", and
 * IndexedDB is checked first, so a busy IndexedDB workspace leaves OPFS untouched too. */
export async function deleteWorkspace(
  selection: StoredWorkspaceSelection,
  options?: { readonly signal?: AbortSignal },
): Promise<"deleted" | "missing" | "busy"> {
  if (selection.mode !== "fast") throw new TypeError("Stored workspaces require fast mode");
  if (typeof selection.name !== "string" || !selection.name)
    throw new TypeError("A stored workspace needs a name");
  const signal = options?.signal;
  signal?.throwIfAborted();
  const [{ deleteIdle }, { OpfsStorage }] = await Promise.all([
    import("./idle-owner.js"),
    import("./opfs.js"),
  ]);
  const indexeddb = await deleteIdle(selection.name, signal);
  if (indexeddb === "busy") return "busy";
  const opfs = await OpfsStorage.deleteIdle(selection.name, { signal });
  if (opfs === "busy") return "busy";
  return indexeddb === "deleted" || opfs === "deleted" ? "deleted" : "missing";
}

export async function openIdleWorkspace(
  selection: StoredWorkspaceSelection,
  options?: { readonly signal?: AbortSignal },
): Promise<IdleWorkspace | "busy" | "missing"> {
  if (selection.mode !== "fast") throw new TypeError("Stored workspaces require fast mode");
  options?.signal?.throwIfAborted();
  const { openIdle } = await import("./idle-owner.js");
  return openIdle(selection.name, options?.signal);
}
