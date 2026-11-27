import type { Readiness, Stream } from "../core/descriptors.js";
import { allocateSharedControl } from "../memory/control.ts";
import { ProcessErrno, ProcessError } from "./errors.ts";
import {
  Int32ArrayConstructor,
  atomicsAdd,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  isSharedArrayBuffer,
  typedArrayLength,
} from "./intrinsics.ts";
import {
  PipeEndpoint,
  attachPipeEndpoint,
  type PipeEndpointHandle,
  type PipeOptions,
} from "./pipes.js";

export type PtyRole = "master" | "slave";

export interface PtySize {
  readonly cols: number;
  readonly rows: number;
  readonly seq: number;
}

export interface PtyEndpointHandle {
  readonly role: PtyRole;
  readonly read: PipeEndpointHandle;
  readonly write: PipeEndpointHandle;
  readonly geometry: SharedArrayBuffer;
}

/** Four Int32 words: [packed (rows << 16) | cols, resizeSeq, reserved, reserved]. */
export const PTY_GEOMETRY_BYTES = 16;
export const MAX_PTY_DIMENSION = 0xffff;

export function isValidPtyDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PTY_DIMENSION;
}

export function validatePtyDimensions(cols: number, rows: number): void {
  if (!isValidPtyDimension(cols) || !isValidPtyDimension(rows))
    throw new ProcessError(ProcessErrno.INVAL, "invalid pty dimensions");
}

function isValidPtyGeometryBuffer(buffer: unknown): buffer is SharedArrayBuffer {
  if (!isSharedArrayBuffer(buffer)) return false;
  return typedArrayLength(new Int32ArrayConstructor(buffer)) >= 4;
}

function packPtySize(cols: number, rows: number): number {
  return ((rows & 0xffff) << 16) | (cols & 0xffff);
}

export function allocatePtyGeometry(
  cols: number,
  rows: number,
  allocateShared?: (bytes: number) => SharedArrayBuffer,
): SharedArrayBuffer {
  validatePtyDimensions(cols, rows);
  const buffer = allocateShared
    ? allocateShared(PTY_GEOMETRY_BYTES)
    : allocateSharedControl(PTY_GEOMETRY_BYTES);
  const cells = new Int32ArrayConstructor(buffer, 0, 4);
  atomicsStore(cells, 0, packPtySize(cols, rows));
  atomicsStore(cells, 1, 0);
  atomicsStore(cells, 2, 0);
  atomicsStore(cells, 3, 0);
  return buffer;
}

/** Bidirectional guest-allocatable PTY endpoint backed by two shared pipe rings and one
 * shared geometry control block. Slave endpoints report `kind: "terminal"` (TTY), while
 * master endpoints report `kind: "pipe"` (controller stream). */
export class PtyEndpoint implements Stream {
  readonly kind: "pipe" | "terminal";
  readonly notification: Int32Array;
  private readonly geometry: Int32Array;
  private closed = false;
  constructor(
    readonly role: PtyRole,
    private readonly readEnd: PipeEndpoint,
    private readonly writeEnd: PipeEndpoint,
    private readonly geometryBuffer: SharedArrayBuffer,
  ) {
    if (!isValidPtyGeometryBuffer(geometryBuffer))
      throw new TypeError("invalid pty geometry buffer");
    this.kind = role === "slave" ? "terminal" : "pipe";
    this.notification = readEnd.notification;
    this.geometry = new Int32ArrayConstructor(geometryBuffer, 0, 4);
  }
  get pid(): number {
    return this.readEnd.pid;
  }
  get live(): boolean {
    return !this.closed && this.readEnd.live && this.writeEnd.live;
  }
  get fdflags(): number {
    return this.readEnd.fdflags;
  }
  set fdflags(value: number) {
    this.readEnd.fdflags = value;
    this.writeEnd.fdflags = value;
  }
  read(chunks: readonly Uint8Array[]): number {
    return this.readEnd.read(chunks);
  }
  tryRead(chunks: readonly Uint8Array[]): number {
    return this.readEnd.tryRead(chunks);
  }
  write(chunks: readonly Uint8Array[]): number {
    return this.writeEnd.write(chunks);
  }
  tryWrite(chunks: readonly Uint8Array[]): number {
    return this.writeEnd.tryWrite(chunks);
  }
  readiness(): Readiness {
    const readState = this.readEnd.readiness();
    const writeState = this.writeEnd.readiness();
    return {
      readable: readState.readable,
      writable: writeState.writable,
      hangup: readState.hangup || writeState.hangup,
      nbytes: readState.nbytes,
    };
  }
  size(): PtySize {
    for (;;) {
      const seq1 = atomicsLoad(this.geometry, 1);
      const packed = atomicsLoad(this.geometry, 0);
      const seq2 = atomicsLoad(this.geometry, 1);
      if (seq1 !== seq2) continue;
      return {
        cols: packed & 0xffff,
        rows: (packed >>> 16) & 0xffff,
        seq: seq1 >>> 0,
      };
    }
  }
  resize(cols: number, rows: number): void {
    validatePtyDimensions(cols, rows);
    atomicsStore(this.geometry, 0, packPtySize(cols, rows));
    atomicsAdd(this.geometry, 1, 1);
    atomicsAdd(this.notification, 0, 1);
    atomicsNotify(this.notification, 0);
  }
  handle(): PtyEndpointHandle {
    return {
      role: this.role,
      read: this.readEnd.handle(),
      write: this.writeEnd.handle(),
      geometry: this.geometryBuffer,
    };
  }
  forProcess(pid: number): PtyEndpoint {
    if (!this.live) throw new Error("pty endpoint is closed");
    if (pid === this.pid) return this;
    const nextRead = this.readEnd.forProcess(pid);
    try {
      const nextWrite = this.writeEnd.forProcess(pid);
      return new PtyEndpoint(this.role, nextRead, nextWrite, this.geometryBuffer);
    } catch (error) {
      nextRead.close();
      throw error;
    }
  }
  retainSuccessor(): PtyEndpoint {
    if (!this.live) throw new Error("pty endpoint is closed");
    const nextRead = this.readEnd.retainSuccessor();
    try {
      const nextWrite = this.writeEnd.retainSuccessor();
      return new PtyEndpoint(this.role, nextRead, nextWrite, this.geometryBuffer);
    } catch (error) {
      nextRead.close();
      throw error;
    }
  }
  revoke(): void {
    try {
      this.readEnd.revoke();
    } finally {
      this.writeEnd.revoke();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.readEnd.close();
    } finally {
      this.writeEnd.close();
    }
  }
}

export function attachPtyEndpoint(
  handle: PtyEndpointHandle,
  options?: Pick<PipeOptions, "allocateShared">,
): PtyEndpoint {
  if (handle.role !== "master" && handle.role !== "slave")
    throw new TypeError("invalid pty endpoint role");
  if (!isValidPtyGeometryBuffer(handle.geometry))
    throw new TypeError("invalid pty geometry buffer");
  const readEnd = attachPipeEndpoint(handle.read, options);
  try {
    const writeEnd = attachPipeEndpoint(handle.write, options);
    return new PtyEndpoint(handle.role, readEnd, writeEnd, handle.geometry);
  } catch (error) {
    readEnd.close();
    throw error;
  }
}
