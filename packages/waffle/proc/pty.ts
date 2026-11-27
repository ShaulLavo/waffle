import type { Readiness, Stream } from "../core/descriptors.js";
import { allocateSharedControl } from "../memory/control.ts";
import { ProcessErrno, ProcessError } from "./errors.ts";
import {
  BigInt64ArrayConstructor,
  Int32ArrayConstructor,
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  isSharedArrayBuffer,
  typedArrayLength,
} from "./intrinsics.ts";

const bigintConstructor = BigInt;
const bigIntAsIntN = BigInt.asIntN;
const numberConstructor = Number;
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

/** Two BigUint64 words: [word0 = (resizeSeq << 32) | (rows << 16) | cols, word1 = reserved]. */
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
  return (((rows & 0xffff) << 16) | (cols & 0xffff)) >>> 0;
}

function packGeometryWord(cols: number, rows: number, seq: number): bigint {
  return bigIntAsIntN(
    64,
    (bigintConstructor(seq >>> 0) << 32n) | bigintConstructor(packPtySize(cols, rows)),
  );
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
  const words = new BigInt64ArrayConstructor(buffer, 0, 2);
  atomicsStore(words, 0, packGeometryWord(cols, rows, 0));
  atomicsStore(words, 1, 0n);
  return buffer;
}

/** Bidirectional guest-allocatable PTY endpoint backed by two shared pipe rings and one
 * shared geometry control block. Slave endpoints report `kind: "terminal"` (TTY), while
 * master endpoints report `kind: "pipe"` (controller stream). */
export class PtyEndpoint implements Stream {
  readonly kind: "pipe" | "terminal";
  readonly notification: Int32Array;
  private readonly geometry: BigInt64Array<SharedArrayBuffer>;
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
    this.geometry = new BigInt64ArrayConstructor(geometryBuffer, 0, 2);
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
    const word = atomicsLoad(this.geometry, 0);
    const packed = numberConstructor(word & 0xffffffffn);
    const seq = numberConstructor((word >> 32n) & 0xffffffffn);
    return {
      cols: packed & 0xffff,
      rows: (packed >>> 16) & 0xffff,
      seq,
    };
  }
  resize(cols: number, rows: number): void {
    validatePtyDimensions(cols, rows);
    const dims = bigintConstructor(packPtySize(cols, rows));
    for (;;) {
      const prev = atomicsLoad(this.geometry, 0);
      const nextSeq = (((prev >> 32n) & 0xffffffffn) + 1n) & 0xffffffffn;
      const next = bigIntAsIntN(64, (nextSeq << 32n) | dims);
      if (atomicsCompareExchange(this.geometry, 0, prev, next) === prev) break;
    }
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
