import {
  arrayAppend,
  MapConstructor,
  mapGet,
  mapSet,
  mapHas,
  mapDelete,
  mapSize,
  mapForEach,
} from "../proc/intrinsics.ts";
import type { FileHandle } from "./filesystem.js";

export interface Readiness {
  readable: boolean;
  writable: boolean;
  hangup: boolean;
  nbytes?: number;
}
/** Pipe and terminal services supply I/O and level-triggered readiness, never guest pointers.
 * I/O returns a byte count or negative WASI errno. Preview1 adapters may block inside read/write.
 */
export interface Stream {
  kind: "pipe" | "terminal";
  read(chunks: readonly Uint8Array[]): number;
  write(chunks: readonly Uint8Array[]): number;
  /** Explicit immediate operations for async guests; never fall back to blocking preview1 I/O. */
  tryRead?(chunks: readonly Uint8Array[]): number;
  tryWrite?(chunks: readonly Uint8Array[]): number;
  readiness(): Readiness;
  /** Shared sequence incremented and notified after readiness changes. */
  readonly notification?: Int32Array;
  close?(): void;
  /** A process gets independent capabilities; dup within one process keeps its description. */
  forProcess?(pid: number): Stream;
  /** Freeze shared I/O before releasing references or requesting physical termination. */
  revoke?(): void;
}
export type Resource =
  | { kind: "file"; handle: FileHandle; offset: number; append: boolean; fdflags?: number }
  | { kind: "directory"; handle: FileHandle }
  | Stream;

function describeResource(resource: Resource, release?: () => void): OpenDescription {
  return new OpenDescription(
    resource,
    release ??
      (resource.kind === "pipe" || resource.kind === "terminal"
        ? () => resource.close?.()
        : undefined),
  );
}

/** POSIX open description: offset, flags and lifetime shared by all descriptor references. */
export class OpenDescription {
  private count = 0;
  get references(): number {
    return this.count;
  }
  private released = false;
  constructor(
    public readonly resource: Resource,
    private readonly release?: () => void,
  ) {}
  retain(): void {
    if (this.released) throw new Error("open description is closed");
    this.count++;
  }
  drop(): void {
    if (this.count === 0) throw new Error("open description has no references");
    if (--this.count === 0) {
      this.released = true;
      this.release?.();
    }
  }
}
export interface Descriptor {
  description: OpenDescription;
  readonly resource: Resource;
  rightsBase: bigint;
  rightsInheriting: bigint;
  preopen?: string;
}
/** Successful runtime_proc fd results must also be nonnegative WASM i32 values. */
export const MAX_DESCRIPTOR = 0x7fffffff;
export class DescriptorTable {
  private entries = new MapConstructor<number, Descriptor>();
  private next = 0;
  private cleanupFailures: unknown[] = [];
  /** Deliver a failed transferred-resource release to this table's teardown owner once. */
  recordCleanupFailure(error: unknown): void {
    arrayAppend(this.cleanupFailures, error);
  }
  get(fd: number): Descriptor | undefined {
    return mapGet(this.entries, fd);
  }
  /** The caller's live root capability, including any guest rights reductions. */
  rootPreopen(): Descriptor | undefined {
    let root: Descriptor | undefined;
    mapForEach(this.entries, (entry) => {
      if (entry.preopen === "/" && entry.resource.kind === "directory") root = entry;
    });
    return root;
  }
  /** Non-consuming runtime_proc classification; independent of rights and preview1 filetype. */
  kind(fd: number): number {
    const entry = mapGet(this.entries, fd);
    if (!entry) return -8; // WASI EBADF
    switch (entry.resource.kind) {
      case "pipe":
        return 1;
      case "terminal":
        return 2;
      case "file":
        return 3;
      case "directory":
        return 4;
      default:
        return 0;
    }
  }
  add(
    description: OpenDescription,
    rights: { rightsBase: bigint; rightsInheriting: bigint; preopen?: string },
  ): number {
    if (mapSize(this.entries) > MAX_DESCRIPTOR) throw new RangeError("descriptor table is full");
    let fd = this.next;
    while (mapHas(this.entries, fd)) fd = fd === MAX_DESCRIPTOR ? 0 : fd + 1;
    this.next = fd;
    return this.addAt(fd, description, rights);
  }
  /** Add a descriptor at an exact number without replacing an existing entry. */
  addAt(
    fd: number,
    description: OpenDescription,
    rights: { rightsBase: bigint; rightsInheriting: bigint; preopen?: string },
  ): number {
    if (!Number.isInteger(fd) || fd < 0 || fd > MAX_DESCRIPTOR)
      throw new RangeError("invalid descriptor number");
    if (mapHas(this.entries, fd)) throw new Error(`descriptor ${fd} is already open`);
    if (mapSize(this.entries) > MAX_DESCRIPTOR) throw new RangeError("descriptor table is full");
    description.retain();
    mapSet(this.entries, fd, { ...rights, description, resource: description.resource });
    if (fd === this.next) this.next = fd === MAX_DESCRIPTOR ? 0 : fd + 1;
    return fd;
  }
  open(
    resource: Resource,
    rightsBase: bigint,
    rightsInheriting: bigint,
    release?: () => void,
    preopen?: string,
  ): number {
    return this.add(describeResource(resource, release), { rightsBase, rightsInheriting, preopen });
  }
  openAt(
    fd: number,
    resource: Resource,
    rightsBase: bigint,
    rightsInheriting: bigint,
    release?: () => void,
    preopen?: string,
  ): number {
    return this.addAt(fd, describeResource(resource, release), {
      rightsBase,
      rightsInheriting,
      preopen,
    });
  }
  dup(fd: number): number {
    const entry = mapGet(this.entries, fd);
    if (!entry) return -8;
    // Preopen discovery belongs to the binding, not the shared description.
    return this.add(entry.description, {
      rightsBase: entry.rightsBase,
      rightsInheriting: entry.rightsInheriting,
    });
  }
  /** Retain before replacing, including when both bindings already share the description. */
  inherit(fd: number, source: Descriptor): void {
    if (!Number.isInteger(fd) || fd < 0 || fd > MAX_DESCRIPTOR)
      throw new RangeError("invalid descriptor number");
    source.description.retain();
    this.close(fd);
    mapSet(this.entries, fd, {
      description: source.description,
      resource: source.resource,
      rightsBase: source.rightsBase,
      rightsInheriting: source.rightsInheriting,
    });
    if (fd === this.next) this.next = fd === MAX_DESCRIPTOR ? 0 : fd + 1;
  }
  /** Restore a complete descriptor binding, including preopen metadata, after a failed transaction. */
  restore(fd: number, source: Descriptor): void {
    if (!Number.isInteger(fd) || fd < 0 || fd > MAX_DESCRIPTOR)
      throw new RangeError("invalid descriptor number");
    source.description.retain();
    this.close(fd);
    mapSet(this.entries, fd, { ...source, resource: source.description.resource });
    if (fd === this.next) this.next = fd === MAX_DESCRIPTOR ? 0 : fd + 1;
  }
  close(fd: number): boolean {
    const entry = mapGet(this.entries, fd);
    if (!entry) return false;
    mapDelete(this.entries, fd);
    this.next = Math.min(this.next, fd);
    entry.description.drop();
    return true;
  }
  renumber(from: number, to: number): boolean {
    const entry = mapGet(this.entries, from);
    if (!entry || !mapHas(this.entries, to)) return false;
    if (from === to) return true;
    this.close(to);
    mapSet(this.entries, to, entry);
    mapDelete(this.entries, from);
    this.next = Math.min(this.next, from);
    return true;
  }
  dispose(): void {
    const errors = this.cleanupFailures;
    this.cleanupFailures = [];
    mapForEach(this.entries, (_entry, fd) => {
      try {
        this.close(fd);
      } catch (error) {
        arrayAppend(errors, error);
      }
    });
    if (errors.length) throw new AggregateError(errors, "descriptor release failed");
  }
}
