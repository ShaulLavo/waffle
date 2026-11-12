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

export async function openIdleWorkspace(
  selection: StoredWorkspaceSelection,
  options?: { readonly signal?: AbortSignal },
): Promise<IdleWorkspace | "busy" | "missing"> {
  if (selection.mode !== "fast") throw new TypeError("Stored workspaces require fast mode");
  options?.signal?.throwIfAborted();
  const { openIdle } = await import("./idle-owner.js");
  return openIdle(selection.name, options?.signal);
}
