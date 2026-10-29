import type { DirectoryEntry } from "../core/filesystem.js";
import { FilesystemError, PAGE, TRANSIENT_HANDLES, pack, errno } from "./protocol.js";
import { compileGlob, type GlobPattern } from "./glob.js";
export type { GlobPattern } from "./glob.js";

export interface WalkPlan {
  readonly include: readonly GlobPattern[];
  readonly exclude: readonly GlobPattern[];
  readonly excludeDirectories: readonly GlobPattern[];
  readonly hidden: boolean;
  readonly maxDepth: number | null;
}
export interface WalkCursor {
  readonly id: number;
  readonly sequence: number;
}
export type WalkEntry =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly size: number;
      readonly handle: number | null;
      readonly grant: number | null;
    }
  | { readonly kind: "error"; readonly path: string; readonly errno: number };
export interface WalkPage {
  readonly entries: readonly WalkEntry[];
  readonly next: WalkCursor | null;
}
export interface WalkPageOptions {
  readonly grant: boolean;
  readonly maxEntries: number;
}
export interface WalkStep {
  readonly name: string;
  readonly ino: number;
}
export interface WalkBackend {
  walkLookup(
    root: number,
    steps: readonly WalkStep[],
  ): { handle: number; kind: DirectoryEntry["kind"]; size: number };
  walkSnapshot(root: number, steps: readonly WalkStep[]): readonly DirectoryEntry[];
  retain(handle: number): void;
  release(handle: number): void;
}
export interface WalkTransaction {
  readonly value: WalkCursor | WalkPage;
  commit(): void;
  rollback(): void;
  cancel(): void;
}
interface Frame {
  readonly steps: readonly WalkStep[];
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
  index: number;
}
interface CompiledPlan {
  readonly hidden: boolean;
  readonly maxDepth: number | null;
  readonly include: readonly ((path: string) => boolean)[];
  readonly exclude: readonly ((path: string) => boolean)[];
  readonly prune: readonly ((path: string) => boolean)[];
}
interface Walk {
  readonly id: number;
  readonly root: number;
  readonly plan: CompiledPlan;
  sequence: number;
  frames: Frame[];
  rootHeld: boolean;
}
interface Grant {
  readonly walk: number;
  readonly release: () => void;
}
interface Candidate {
  readonly entry: WalkEntry;
  readonly handle: number | null;
}
const MAX_WALKS = 4;
const MAX_SNAPSHOT_ENTRIES = 65536;
const MAX_SNAPSHOT_UNITS = 1 << 20;
const MAX_PATH = 4096;
let serial = 0;
function nextId(): number {
  if (serial === Number.MAX_SAFE_INTEGER) throw new FilesystemError(6, "walk ids exhausted");
  return ++serial;
}

/** Session-local cursor and grant ownership. No caller-supplied inode or session is used. */
export class WalkTable {
  private readonly walks = new Map<number, Walk>();
  private readonly grants = new Map<number, Grant>();
  constructor(
    private readonly backend: WalkBackend,
    private readonly hold: (handle: number) => () => void,
  ) {}
  get size(): number {
    return this.walks.size;
  }
  get liveGrants(): number {
    return this.grants.size;
  }
  open(root: number, input: unknown): WalkTransaction {
    const plan = compilePlan(input);
    if (this.walks.size >= MAX_WALKS) throw new FilesystemError(6, "four walks per session");
    const entries = this.backend.walkSnapshot(root, []);
    const walk: Walk = {
      id: nextId(),
      root,
      plan,
      sequence: 0,
      frames: [{ steps: [], path: "", entries, index: 0 }],
      rootHeld: true,
    };
    checkSnapshots(walk.frames);
    this.backend.retain(root);
    return {
      value: { id: walk.id, sequence: 0 },
      commit: () => {
        this.walks.set(walk.id, walk);
      },
      rollback: () => {
        this.releaseRoot(walk);
      },
      cancel: this.canceller(walk.id),
    };
  }
  page(input: unknown, options: unknown, capacity: number): WalkTransaction {
    const cursor = parseCursor(input);
    const request = parseOptions(options);
    if (capacity < PAGE) throw new FilesystemError(28, "walk output must admit 64 KiB");
    const walk = this.walks.get(cursor.id);
    if (!walk || walk.sequence !== cursor.sequence || !walk.rootHeld)
      throw new FilesystemError(8, "stale walk cursor");
    const frames = walk.frames.map((frame) => ({ ...frame }));
    const files: Candidate[] = [];
    const credit = request.grant ? TRANSIENT_HANDLES - this.grants.size : 128;
    if (request.grant && credit === 0)
      throw new FilesystemError(6, "release walk grants before paging");
    this.collect(walk, frames, files, Math.min(request.maxEntries, credit), request.grant);
    const next = frames.length ? { id: walk.id, sequence: walk.sequence + 1 } : null;
    const held = new Map<number, Grant>();
    try {
      const entries = files.map((file) => this.grant(walk.id, file, request.grant, held));
      const value: WalkPage = { entries, next };
      if (pack(value).length > PAGE) throw new FilesystemError(29, "walk packing invariant");
      return this.transaction(walk, frames, value, held);
    } catch (error) {
      for (const grant of held.values()) grant.release();
      throw error;
    }
  }
  private transaction(
    walk: Walk,
    frames: Frame[],
    value: WalkPage,
    held: Map<number, Grant>,
  ): WalkTransaction {
    return {
      value,
      commit: () => {
        walk.frames = frames;
        walk.sequence++;
        for (const [token, grant] of held) this.grants.set(token, grant);
        if (!value.next) this.releaseRoot(walk);
        this.retire(walk.id);
      },
      rollback: () => {
        for (const grant of held.values()) grant.release();
      },
      cancel: this.canceller(walk.id),
    };
  }
  private grant(
    walk: number,
    candidate: Candidate,
    requested: boolean,
    held: Map<number, Grant>,
  ): WalkEntry {
    if (!requested || candidate.handle === null || candidate.entry.kind !== "file")
      return candidate.entry;
    const token = nextId();
    held.set(token, { walk, release: this.hold(candidate.handle) });
    return { ...candidate.entry, handle: candidate.handle, grant: token };
  }
  private collect(
    walk: Walk,
    frames: Frame[],
    files: Candidate[],
    limit: number,
    granted: boolean,
  ): void {
    let bytes = pack({ entries: [], next: { id: walk.id, sequence: walk.sequence + 1 } }).length;
    while (frames.length && files.length < limit) {
      const checkpoint = frames.map((frame) => ({ ...frame }));
      const candidate = this.advance(walk, frames);
      if (!candidate) continue;
      const placeholder =
        granted && candidate.entry.kind === "file"
          ? { ...candidate.entry, handle: Number.MAX_SAFE_INTEGER, grant: Number.MAX_SAFE_INTEGER }
          : candidate.entry;
      const entryBytes = pack(placeholder).length + (files.length ? 1 : 0);
      if (bytes + entryBytes <= PAGE) {
        bytes += entryBytes;
        files.push(candidate);
        continue;
      }
      frames.splice(0, frames.length, ...checkpoint);
      if (!files.length) throw new FilesystemError(37, "walk entry exceeds reply bound");
      return;
    }
    while (
      frames.length &&
      frames[frames.length - 1]!.index >= frames[frames.length - 1]!.entries.length
    )
      frames.pop();
  }
  private advance(walk: Walk, frames: Frame[]): Candidate | undefined {
    const frame = frames[frames.length - 1]!;
    if (frame.index >= frame.entries.length) {
      frames.pop();
      return;
    }
    const child = frame.entries[frame.index++]!;
    const path = frame.path ? `${frame.path}/${child.name}` : child.name;
    if (!walk.plan.hidden && child.name.startsWith(".")) return;
    if (walk.plan.maxDepth !== null && frame.steps.length >= walk.plan.maxDepth) return;
    if (!traversable(child.kind)) return;
    if (child.kind === "directory" && matches(walk.plan.prune, path)) return;
    if (child.kind === "file" && matches(walk.plan.exclude, path)) return;
    if (child.kind === "file" && walk.plan.include.length && !matches(walk.plan.include, path))
      return;
    if (path.length > MAX_PATH) throw new FilesystemError(37, "walk path exceeds bound");
    const steps = frame.steps.concat([{ name: child.name, ino: child.ino }]);
    try {
      return this.visit(walk, frames, steps, path, child.kind);
    } catch (error) {
      return { entry: { kind: "error", path, errno: errno(error) }, handle: null };
    }
  }
  private visit(
    walk: Walk,
    frames: Frame[],
    steps: readonly WalkStep[],
    path: string,
    kind: DirectoryEntry["kind"],
  ): Candidate | undefined {
    const node = this.backend.walkLookup(walk.root, steps);
    if (node.kind !== kind) throw new FilesystemError(44);
    if (kind === "directory") {
      if (walk.plan.maxDepth !== null && steps.length >= walk.plan.maxDepth) return;
      const entries = this.backend.walkSnapshot(walk.root, steps);
      const frame = { steps, path, entries, index: 0 };
      checkSnapshots(frames.concat([frame]));
      frames.push(frame);
      return;
    }
    return {
      entry: { kind: "file", path, size: node.size, handle: null, grant: null },
      handle: node.handle,
    };
  }
  release(input: unknown): void {
    if (!Array.isArray(input) || input.length > TRANSIENT_HANDLES) throw new FilesystemError(28);
    const tokens = new Set<number>();
    for (const token of input) {
      if (
        typeof token !== "number" ||
        !Number.isSafeInteger(token) ||
        tokens.has(token) ||
        !this.grants.has(token)
      )
        throw new FilesystemError(8, "unknown walk grant");
      tokens.add(token);
    }
    for (const token of tokens) this.releaseGrant(token);
  }
  close(input: unknown): void {
    const cursor = parseCursor(input);
    const walk = this.walks.get(cursor.id);
    if (!walk) return;
    if (cursor.sequence > walk.sequence) throw new FilesystemError(8);
    this.walks.delete(walk.id);
    this.releaseRoot(walk);
    for (const [token, grant] of this.grants) if (grant.walk === walk.id) this.releaseGrant(token);
  }
  dispose(): void {
    for (const walk of this.walks.values()) this.releaseRoot(walk);
    this.walks.clear();
    for (const token of this.grants.keys()) this.releaseGrant(token);
  }
  private canceller(id: number): () => void {
    return () => this.close({ id, sequence: 0 });
  }
  private releaseRoot(walk: Walk): void {
    if (!walk.rootHeld) return;
    walk.rootHeld = false;
    walk.frames = [];
    this.backend.release(walk.root);
  }
  private releaseGrant(token: number): void {
    const grant = this.grants.get(token)!;
    this.grants.delete(token);
    grant.release();
    this.retire(grant.walk);
  }
  private retire(id: number): void {
    const walk = this.walks.get(id);
    if (!walk || walk.rootHeld) return;
    for (const grant of this.grants.values()) if (grant.walk === id) return;
    this.walks.delete(id);
  }
}
function matches(patterns: readonly ((path: string) => boolean)[], path: string): boolean {
  return patterns.some((pattern) => pattern(path));
}
function parseCursor(value: unknown): WalkCursor {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("sequence" in value) ||
    !natural(value.id) ||
    !natural(value.sequence)
  )
    throw new FilesystemError(28, "invalid walk cursor");
  return { id: value.id, sequence: value.sequence };
}
function parseOptions(value: unknown): WalkPageOptions {
  if (
    !value ||
    typeof value !== "object" ||
    !("grant" in value) ||
    typeof value.grant !== "boolean" ||
    !("maxEntries" in value) ||
    !natural(value.maxEntries) ||
    value.maxEntries < 1 ||
    value.maxEntries > 128
  )
    throw new FilesystemError(28, "invalid walk page options");
  return { grant: value.grant, maxEntries: value.maxEntries };
}
function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function patterns(value: unknown): readonly ((path: string) => boolean)[] {
  if (!Array.isArray(value) || value.length > 128)
    throw new FilesystemError(28, "invalid walk globs");
  return value.map((pattern: unknown) => {
    if (
      !pattern ||
      typeof pattern !== "object" ||
      !("kind" in pattern) ||
      !("glob" in pattern) ||
      typeof pattern.glob !== "string" ||
      (pattern.kind !== "basename" && pattern.kind !== "path")
    )
      throw new FilesystemError(28, "invalid walk glob");
    return compileGlob({ kind: pattern.kind, glob: pattern.glob });
  });
}
function compilePlan(value: unknown): CompiledPlan {
  if (
    !value ||
    typeof value !== "object" ||
    !("include" in value) ||
    !("exclude" in value) ||
    !("excludeDirectories" in value) ||
    !("hidden" in value) ||
    typeof value.hidden !== "boolean" ||
    !("maxDepth" in value) ||
    (value.maxDepth !== null && (!natural(value.maxDepth) || value.maxDepth > 128))
  )
    throw new FilesystemError(28, "invalid walk plan");
  return {
    include: patterns(value.include),
    exclude: patterns(value.exclude),
    prune: patterns(value.excludeDirectories),
    hidden: value.hidden,
    maxDepth: value.maxDepth,
  };
}
function checkSnapshots(frames: readonly Frame[]): void {
  let entries = 0,
    units = 0;
  for (const frame of frames) {
    entries += frame.entries.length;
    units += frame.path.length;
    for (const entry of frame.entries) units += entry.name.length;
  }
  if (frames.length > 128 || entries > MAX_SNAPSHOT_ENTRIES || units > MAX_SNAPSHOT_UNITS)
    throw new FilesystemError(6, "walk snapshot bound exceeded");
}

function traversable(kind: DirectoryEntry["kind"]): kind is "file" | "directory" {
  switch (kind) {
    case "file":
    case "directory":
      return true;
    case "socket":
    case "symlink":
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
