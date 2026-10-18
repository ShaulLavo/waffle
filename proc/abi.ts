import {
  arrayAppend,
  isSharedArrayBuffer,
  DataViewConstructor,
  SharedArrayBufferConstructor,
  Uint8ArrayConstructor,
  dataViewGetBigUint64,
  dataViewGetUint32,
  dataViewSetBigUint64,
  dataViewSetInt32,
  dataViewSetUint32,
  objectValues,
  typedArrayBuffer,
  typedArrayByteLength,
  typedArrayByteOffset,
  typedArrayLength,
  reflectApply,
  SetConstructor,
  setHas,
  setAdd,
} from "./intrinsics.ts";
import { ExecutionUnwind } from "../core/unwind.js";
import { type ControlCells, controlLoad, controlWait } from "./control.js";
import {
  MAX_DESCRIPTOR,
  type Descriptor,
  type DescriptorTable,
  type Readiness,
  type Stream,
} from "../core/descriptors.js";
import type { FileSystem } from "../core/filesystem.js";
import { withFileOffset } from "../core/open-file.js";
import { PipeController } from "./pipes.js";
import { readOutcome } from "./outcome.js";
import { WasiExit } from "../core/wasi.js";
import { waitStatus } from "./wait-status.js";
import { spawnError, startFailureErrno } from "./start-failure.js";
import { FilesystemError } from "../fs/protocol.js";
import {
  checkedSignalNumber,
  defaultSignalTerminates,
  requestSignal,
  setSignalDisposition,
  signalPending,
  takeSignal,
  type SignalTransport,
} from "./signals.js";
import {
  ProcessErrno,
  ProcessError,
  Signal,
  type ProcessExit,
  type SpawnRequest,
} from "./types.js";

/** Synchronous control plane. Implementations reserve/retain before returning from spawn;
 * module loading and guest startup happen elsewhere, never on this import's stack. */
export interface ProcessService {
  spawn(parentPid: number, request: SpawnRequest): number;
  /** Consume one safely exited child; null means it is still pending. */
  wait(parentPid: number, pid: number): ProcessExit | null;
  /** Observe child readiness without consuming its status or capacity. */
  childExited(parentPid: number, pid: number): boolean;
  startStatus(parentPid: number, pid: number): number;
  registerChildStartWake?(parentPid: number, pid: number, wake: Int32Array): () => void;
  waitJob(callerPid: number, job: number): ProcessExit | null;
  jobEmpty(callerPid: number, job: number): boolean;
  registerJobWake?(callerPid: number, job: number, wake: Int32Array): () => void;
  kill(pid: number, signal: number): void;
  killJob(job: number, signal: number): void;
  jobOf(pid: number): number;
  defaultSignal(pid: number, signal: number): void;
  /** Privileged local services check guest authority; broker clients are already caller-bound. */
  canSignal?(callerPid: number, targetPid: number): boolean;
  canSignalJob?(callerPid: number, job: number): boolean;
  accessStart?(pid: number, path: string, cwd: string, wake?: Int32Array): number;
  accessTake?(pid: number, request: number): number;
  accessCancel?(pid: number, request: number): number;
  accessReady?(pid: number, request: number): boolean;
  filesystemReady?(pid: number, request: number): boolean;
  registerRevocation?(pid: number, hook: () => void): () => void;
}

interface NonblockingFileSystem extends FileSystem {
  tryRead?(handle: number, chunks: readonly Uint8Array[], offset: number): number;
  tryWrite?(handle: number, chunks: readonly Uint8Array[], offset: number): number;
  tryAppend?(
    handle: number,
    chunks: readonly Uint8Array[],
  ): { written: number; offset: number } | number;
  ioReadiness?(handle: number, writing: boolean): Readiness;
  readiness?(request: number): { ready: boolean } | undefined;
}
interface NonblockingStream extends Stream {
  readonly notification?: Int32Array;
  tryRead?(chunks: readonly Uint8Array[]): number;
  tryWrite?(chunks: readonly Uint8Array[]): number;
  registerWake?(wake: Int32Array): (() => void) | void;
}
export interface ProcessABIOptions {
  memory: WebAssembly.Memory | (() => WebAssembly.Memory);
  descriptors: DescriptorTable;
  fs: FileSystem;
  pid: number;
  service: ProcessService;
  signals: SignalTransport;
  pipeCapacity?: number;
  /** Workers inject broker-owned endpoints; the default is an in-process controller. */
  createPipe?(): readonly [Stream, Stream];
  /** One shared readiness sequence. Publishers increment and notify after publishing state. */
  wake?: Int32Array;
  /** Synchronous wait hook, primarily for embedders and deterministic tests. poll and blocking wait_job call it. */
  wait?(milliseconds: number, word: ControlCells, expected: number): void;
  now?(): number;
}

/** Explicit default-action unwind; an unrelated WASM trap must never be treated as a signal. */
export class ProcessSignalExit extends ExecutionUnwind {
  readonly status: number;
  constructor(readonly signal: number) {
    super(`default action for signal ${signal}`);
    this.name = "ProcessSignalExit";
    this.status = 128 + signal;
  }
}

const READ = 1n << 1n,
  WRITE = 1n << 6n,
  POLL = 1n << 27n;
const FAULT = 21,
  ISDIR = 31,
  NOSYS = 52,
  NOTCAPABLE = 76;
const decode = new TextDecoder("utf-8", { fatal: true });
// A leading BOM is a filename character, not a byte-order marker to strip.
const pathDecode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const clock = performance.now.bind(performance);
type Subscription = { kind: number; id: number; userdata: bigint };

/** Guest adapter for the runtime_proc WASM namespace. Only poll and blocking wait_job wait.
 * FileSystem must provide immediate I/O; worker-backed services supply nonblocking file I/O.
 * Streams with potentially blocking read/write must expose tryRead/tryWrite. */
export class ProcessABI {
  readonly imports: Record<string, (...args: number[]) => number>;
  private readonly now: () => number;
  constructor(private readonly options: ProcessABIOptions) {
    if (
      options.wake &&
      (!isSharedArrayBuffer(typedArrayBuffer(options.wake)) || typedArrayLength(options.wake) !== 1)
    ) {
      throw new TypeError("poll wake must be one shared int32");
    }
    this.now = options.now ?? clock;
    this.imports = {
      getpid: () => options.pid,
      access_start: (ptr, length, cwdPtr, cwdLength, mode) =>
        this.result(() => this.accessStart(ptr!, length!, cwdPtr!, cwdLength!, mode!)),
      access_take: (request) =>
        this.result(() => options.service.accessTake?.(options.pid, request!) ?? -NOSYS),
      access_cancel: (request) =>
        this.result(() => options.service.accessCancel?.(options.pid, request!) ?? -NOSYS),
      spawn: (ptr, length) =>
        this.result(() => {
          try {
            return options.service.spawn(options.pid, this.spawnRequest(ptr!, length!));
          } catch (error) {
            throw spawnError(error);
          }
        }),
      job_of: (pid) => this.result(() => options.service.jobOf(pid === 0 ? options.pid : pid!)),
      pipe: (ptr) => this.result(() => this.pipe(ptr!)),
      dup: (fd) => options.descriptors.dup(fd! >>> 0),
      read: (fd, ptr, length) => this.result(() => this.io(false, fd!, ptr!, length!)),
      write: (fd, ptr, length) => this.result(() => this.io(true, fd!, ptr!, length!)),
      wait: (pid, ptr) => this.result(() => this.wait(pid!, ptr!)),
      wait_job: (job, flags, ptr) => this.result(() => this.waitJob(job!, flags!, ptr!)),
      kill: (pid, signal) =>
        this.result(() => {
          if (options.service.canSignal?.(options.pid, pid!) === false) return -63;
          options.service.kill(pid!, signal!);
          return 0;
        }),
      kill_job: (job, signal) =>
        this.result(() => {
          if (options.service.canSignalJob?.(options.pid, job!) === false) return -63;
          options.service.killJob(job!, signal!);
          return 0;
        }),
      start_status: (pid) => this.result(() => options.service.startStatus(options.pid, pid!)),
      poll: (ptr, count, timeout, out) =>
        this.result(() => this.poll(ptr!, count!, timeout!, out!)),
      interrupted: () => this.interrupted(),
      signal: (signal, mode) => this.signal(signal!, mode!),
      default_signal: (signal) => this.result(() => this.defaultSignal(signal!)),
    };
  }
  private result(operation: () => number): number {
    try {
      return operation();
    } catch (error) {
      if (error instanceof ProcessError || error instanceof FilesystemError) return -error.errno;
      if (error instanceof RangeError) return -48; // ENOMEM, including host buffer allocation.
      throw error;
    }
  }
  private memory(): WebAssembly.Memory {
    return typeof this.options.memory === "function" ? this.options.memory() : this.options.memory;
  }
  private span(ptr: number, length: number): Uint8Array {
    ptr >>>= 0;
    length >>>= 0;
    const memory = this.memory();
    if (length > memory.buffer.byteLength - ptr)
      throw new ProcessError(FAULT, "guest memory out of bounds");
    return new Uint8ArrayConstructor(memory.buffer, ptr, length);
  }
  private view(ptr: number, length: number): DataView {
    const bytes = this.span(ptr, length);
    return new DataViewConstructor(
      typedArrayBuffer(bytes),
      typedArrayByteOffset(bytes),
      typedArrayByteLength(bytes),
    );
  }
  private accessPath(ptr: number, length: number): string {
    const bytes = new Uint8ArrayConstructor(this.span(ptr, length));
    let path: string;
    try {
      path = pathDecode.decode(bytes);
    } catch {
      throw new ProcessError(ProcessErrno.INVAL, "invalid path encoding");
    }
    if (!path || path.includes("\0")) throw new ProcessError(ProcessErrno.INVAL, "invalid path");
    return path;
  }
  private accessStart(
    ptr: number,
    length: number,
    cwdPtr: number,
    cwdLength: number,
    mode: number,
  ): number {
    if (mode !== 1) return -ProcessErrno.INVAL;
    const path = this.accessPath(ptr, length),
      cwd = this.accessPath(cwdPtr, cwdLength);
    if (!cwd.startsWith("/")) return -ProcessErrno.INVAL;
    return (
      this.options.service.accessStart?.(this.options.pid, path, cwd, this.options.wake) ?? -NOSYS
    );
  }
  private spawnRequest(ptr: number, length: number): SpawnRequest {
    // Guest memory may be resizable; TextDecoder's WebIDL input requires a fixed buffer.
    const bytes = new Uint8ArrayConstructor(this.span(ptr, length));
    let request: unknown;
    try {
      request = JSON.parse(decode.decode(bytes));
    } catch {
      throw new ProcessError(ProcessErrno.INVAL, "invalid spawn JSON");
    }
    const object = request as Partial<SpawnRequest> | null;
    const fd = (value: unknown): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DESCRIPTOR;
    if (
      !object ||
      typeof object !== "object" ||
      typeof object.executable !== "string" ||
      !object.executable ||
      !Array.isArray(object.argv) ||
      !object.argv.every((value) => typeof value === "string") ||
      !object.env ||
      typeof object.env !== "object" ||
      Array.isArray(object.env) ||
      !objectValues(object.env).every((value) => typeof value === "string") ||
      typeof object.cwd !== "string" ||
      !object.cwd ||
      !Number.isInteger(object.job) ||
      object.job! < -1 ||
      !Array.isArray(object.fds) ||
      !object.fds.every(
        (binding) =>
          binding && typeof binding === "object" && fd(binding.child) && fd(binding.parent),
      )
    ) {
      throw new ProcessError(ProcessErrno.INVAL, "invalid spawn description");
    }
    return object as SpawnRequest;
  }
  private pipe(ptr: number): number {
    // Validate before retaining endpoints or mutating the descriptor namespace.
    this.span(ptr, 8);
    const endpoints = this.options.createPipe?.() ?? this.localPipe();
    let read: number | undefined, write: number | undefined;
    try {
      read = this.options.descriptors.open(endpoints[0], READ | POLL, 0n);
      write = this.options.descriptors.open(endpoints[1], WRITE | POLL, 0n);
      const output = this.view(ptr, 8);
      dataViewSetUint32(output, 0, read, true);
      dataViewSetUint32(output, 4, write, true);
      return 0;
    } catch (error) {
      if (read !== undefined) this.options.descriptors.close(read);
      else endpoints[0].close?.();
      if (write !== undefined) this.options.descriptors.close(write);
      else endpoints[1].close?.();
      throw error;
    }
  }
  private localPipe(): readonly [Stream, Stream] {
    const controller = new PipeController({
      capacity: this.options.pipeCapacity,
      wake: this.options.wake,
    });
    const read = controller.retain(this.options.pid, "read");
    let write: Stream;
    try {
      write = controller.retain(this.options.pid, "write");
    } catch (error) {
      read.close?.();
      throw error;
    }
    const unregister = this.options.service.registerRevocation?.(this.options.pid, () =>
      controller.revoke(this.options.pid),
    );
    if (unregister) {
      let remaining = 2;
      const endpoints = [read, write];
      for (let index = 0; index < endpoints.length; index++) {
        const endpoint = endpoints[index]!;
        const close = endpoint.close;
        let closed = false;
        endpoint.close = () => {
          if (closed) return;
          closed = true;
          try {
            if (close) reflectApply(close, endpoint, []);
          } finally {
            if (--remaining === 0) unregister();
          }
        };
      }
    }
    return [read, write];
  }
  private descriptor(fd: number, rights: bigint): Descriptor {
    const entry = this.options.descriptors.get(fd >>> 0);
    if (!entry) throw new ProcessError(ProcessErrno.BADF, `missing descriptor ${fd}`);
    if ((entry.rightsBase & rights) !== rights)
      throw new ProcessError(NOTCAPABLE, "descriptor rights denied");
    return entry;
  }
  private io(write: boolean, fd: number, ptr: number, length: number): number {
    const entry = this.descriptor(fd, write ? WRITE : READ),
      resource = entry.resource;
    if (resource.kind === "directory") return -ISDIR;
    const bytes = this.span(ptr, length);
    if (typedArrayLength(bytes) === 0) return 0;
    if (resource.kind === "file") {
      const fs: NonblockingFileSystem = this.options.fs;
      return withFileOffset(
        resource,
        () => {
          if (write && resource.append) {
            const result = fs.tryAppend
              ? fs.tryAppend(resource.handle, [bytes])
              : fs.append(resource.handle, [bytes]);
            if (typeof result === "number") return result;
            resource.offset = result.offset;
            return result.written;
          }
          const position = resource.offset;
          const count = write
            ? fs.tryWrite
              ? fs.tryWrite(resource.handle, [bytes], position)
              : fs.write(resource.handle, [bytes], position)
            : fs.tryRead
              ? fs.tryRead(resource.handle, [bytes], position)
              : fs.read(resource.handle, [bytes], position);
          if (count >= 0) resource.offset = position + count;
          return count;
        },
        true,
      );
    }
    const stream: NonblockingStream = resource;
    if (write && stream.tryWrite) return stream.tryWrite([bytes]);
    if (!write && stream.tryRead) return stream.tryRead([bytes]);
    // readiness describes availability, not whether read/write may enter a blocking callback.
    // A terminal backed only by preview1 stdin must opt into the immediate I/O contract.
    return stream.kind === "terminal" ? -ProcessErrno.AGAIN : -NOSYS;
  }
  private wait(pid: number, ptr: number): number {
    this.span(ptr, 8);
    const result = this.options.service.wait(this.options.pid, pid);
    if (!result) return -ProcessErrno.AGAIN;
    this.writeWaitResult(ptr, result);
    return 0;
  }
  private writeWaitResult(ptr: number, result: ProcessExit): void {
    const output = this.view(ptr, 8);
    dataViewSetUint32(
      output,
      0,
      result.kind === "exited" ? 0 : result.kind === "signaled" ? 1 : 2,
      true,
    );
    dataViewSetInt32(
      output,
      4,
      result.kind === "start-failed" ? startFailureErrno(result.error) : result.code,
      true,
    );
  }
  private waitJob(job: number, flags: number, ptr: number): number {
    if (flags !== 0 && flags !== 1) return -ProcessErrno.INVAL;
    this.span(ptr, 8); // Faults must not consume a completed job.
    const wake = this.options.wake;
    const release = wake
      ? this.options.service.registerJobWake?.(this.options.pid, job, wake)
      : undefined;
    try {
      for (;;) {
        const word = wake ?? this.options.signals.interrupt;
        const sequence = controlLoad(word, 0);
        // Validate/read readiness separately so a host callback growing memory cannot cause
        // a fault after the consuming operation. No guest code runs between validation/reap.
        if (this.options.service.jobEmpty(this.options.pid, job)) {
          this.span(ptr, 8);
          const result = this.options.service.waitJob(this.options.pid, job);
          if (result) {
            this.writeWaitResult(ptr, result);
            return 0;
          }
        }
        if (flags === 1) return -ProcessErrno.AGAIN;
        if (this.pending()) return -27; // EINTR; no signal consumed.
        if (this.options.wait) this.options.wait(10, word, sequence);
        else controlWait(word, 0, sequence, 10);
      }
    } finally {
      release?.();
    }
  }
  private pending(): boolean {
    return signalPending(this.options.signals);
  }
  private interrupted(): number {
    // Fatal outcomes are not handled deliveries. Stop before user code can run another handler.
    const fatal = readOutcome(this.options.signals.outcome);
    if (fatal?.kind === "signaled") throw new ProcessSignalExit(fatal.code);
    const signal = takeSignal(this.options.signals.signalState, this.options.signals.interrupt);
    const raced = readOutcome(this.options.signals.outcome);
    if (raced?.kind === "signaled") throw new ProcessSignalExit(raced.code);
    return signal;
  }
  private signal(signal: number, mode: number): number {
    if (signal === 0 && mode === 0) return this.interrupted();
    if (signal === 0 && mode === 4) {
      const fatal = readOutcome(this.options.signals.outcome);
      if (fatal?.kind === "signaled") throw new ProcessSignalExit(fatal.code);
      return 0;
    }
    try {
      checkedSignalNumber(signal);
      if (
        !Number.isInteger(mode) ||
        mode < 0 ||
        mode > 3 ||
        (signal === Signal.SIGKILL && mode !== 3)
      )
        return -ProcessErrno.INVAL;
      if (mode === 3) {
        const result = requestSignal(this.options.signals, signal);
        if (result.action === "default" && result.outcome?.kind === "signaled")
          this.defaultSignal(result.outcome.code);
      } else if (
        setSignalDisposition(
          this.options.signals.signalState,
          signal,
          mode,
          this.options.signals.interrupt,
        )
      )
        this.defaultSignal(signal);
      return 0;
    } catch (error) {
      if (error instanceof ProcessError || error instanceof FilesystemError) return -error.errno;
      if (error instanceof RangeError) return -48; // ENOMEM, including host buffer allocation.
      throw error;
    }
  }
  private defaultSignal(signal: number): number {
    checkedSignalNumber(signal);
    let winner = readOutcome(this.options.signals.outcome);
    const killed = controlLoad(this.options.signals.requestedSignal, 0) === Signal.SIGKILL;
    if (!winner && !killed && !defaultSignalTerminates(signal)) return 0;
    if (!winner || winner.kind === "signaled") {
      this.options.service.defaultSignal(
        this.options.pid,
        winner?.code ?? (killed ? Signal.SIGKILL : signal),
      );
      winner = readOutcome(this.options.signals.outcome);
    }
    if (!winner) throw new Error("default signal action did not publish a terminal outcome");
    if (winner.kind !== "signaled") throw new WasiExit(waitStatus(winner));
    throw new ProcessSignalExit(winner.code);
  }
  private readiness(sub: Subscription): Readiness | null {
    if (sub.kind === 6)
      return this.options.service.startStatus(this.options.pid, sub.id) !== -ProcessErrno.AGAIN
        ? { readable: true, writable: false, hangup: false }
        : null;
    if (sub.kind === 5) {
      const ready = this.options.service.accessReady?.(this.options.pid, sub.id);
      if (ready === undefined)
        throw new ProcessError(NOSYS, "executable query service is unavailable");
      return ready ? { readable: true, writable: false, hangup: false } : null;
    }
    if (sub.kind === 4)
      return this.options.service.jobEmpty(this.options.pid, sub.id)
        ? { readable: true, writable: false, hangup: false }
        : null;
    if (sub.kind === 2)
      return this.options.service.childExited(this.options.pid, sub.id)
        ? { readable: true, writable: false, hangup: false }
        : null;
    const fs: NonblockingFileSystem = this.options.fs;
    if (sub.kind === 3) {
      const ready = this.options.service.filesystemReady
        ? this.options.service.filesystemReady(this.options.pid, sub.id)
        : fs.readiness?.(sub.id)?.ready;
      if (ready === undefined)
        throw new ProcessError(NOSYS, "filesystem completion service is unavailable");
      return ready ? { readable: true, writable: false, hangup: false } : null;
    }
    const resource = this.descriptor(sub.id, POLL).resource;
    if (resource.kind === "file") {
      let state: Readiness = { readable: false, writable: false, hangup: false };
      const result = withFileOffset(
        resource,
        () => {
          state = fs.ioReadiness?.(resource.handle, sub.kind === 1) ?? {
            readable: true,
            writable: true,
            hangup: false,
          };
          return 0;
        },
        true,
      );
      return result < 0 && result !== -ProcessErrno.AGAIN ? { ...state, hangup: true } : state;
    }
    if (resource.kind === "directory") return { readable: true, writable: true, hangup: false };
    // Preview1 terminal callbacks may block. Availability there is not immediate ABI I/O:
    // an unsupported direction must not report ready (including hangup) forever after EAGAIN.
    if (resource.kind === "terminal" && !(sub.kind === 1 ? resource.tryWrite : resource.tryRead)) {
      return { readable: false, writable: false, hangup: false };
    }
    return resource.readiness();
  }
  private poll(ptr: number, count: number, timeout: number, out: number): number {
    count >>>= 0;
    if (!Number.isInteger(timeout) || timeout < -1) return -ProcessErrno.INVAL;
    if (count > Math.floor(this.memory().buffer.byteLength / 16)) return -FAULT;
    const input = this.view(ptr, count * 16);
    this.span(out, count * 16);
    const subscriptions: Subscription[] = [];
    for (let index = 0; index < count; index++) {
      const at = index * 16;
      const sub = {
        kind: dataViewGetUint32(input, at, true),
        id: dataViewGetUint32(input, at + 4, true),
        userdata: dataViewGetBigUint64(input, at + 8, true),
      };
      if (sub.kind > 6) return -ProcessErrno.INVAL;
      subscriptions.push(sub);
    }
    if (this.pending()) return 0;
    const unregister: (() => void)[] = [];
    const wake = this.options.wake;
    try {
      if (wake) {
        const resources = new SetConstructor<Stream>();
        for (const sub of subscriptions) {
          if (sub.kind === 6) {
            const release = this.options.service.registerChildStartWake?.(
              this.options.pid,
              sub.id,
              wake,
            );
            if (release) arrayAppend(unregister, release);
          }
          if (sub.kind === 4) {
            const release = this.options.service.registerJobWake?.(this.options.pid, sub.id, wake);
            if (release) arrayAppend(unregister, release);
          }
          if (sub.kind > 1) continue;
          const resource = this.descriptor(sub.id, POLL).resource;
          if (resource.kind === "file" || resource.kind === "directory") continue;
          if (!setHas(resources, resource)) {
            setAdd(resources, resource);
            const stream: NonblockingStream = resource;
            const release = stream.registerWake?.(wake);
            if (release) arrayAppend(unregister, release);
          }
        }
      }
      const deadline = timeout === -1 ? Infinity : this.now() + timeout;
      for (;;) {
        // Observe sequence before state; publication racing scan makes Atomics.wait return immediately.
        const word = wake ?? this.options.signals.interrupt;
        const sequence = controlLoad(word, 0);
        if (this.pending()) return 0;
        const ready: { sub: Subscription; flags: number }[] = [];
        for (const sub of subscriptions) {
          const state = this.readiness(sub);
          if (state && ((sub.kind === 1 ? state.writable : state.readable) || state.hangup))
            ready.push({ sub, flags: state.hangup ? 1 : 0 });
        }
        if (ready.length) {
          // Waiting/host services can grow memory; never retain a DataView across them.
          const output = this.view(out, ready.length * 16);
          ready.forEach(({ sub, flags }, index) => {
            const at = index * 16;
            dataViewSetBigUint64(output, at, sub.userdata, true);
            dataViewSetUint32(output, at + 8, sub.kind, true);
            dataViewSetUint32(output, at + 12, flags, true);
          });
          return ready.length;
        }
        if (this.pending()) return 0;
        const remaining = deadline - this.now();
        if (remaining <= 0) return 0;
        // Signals, local child exits and filesystem locks may publish on independent cells.
        // Until every source guarantees this common wake, rescan within 10 ms even when pipe
        // readiness uses it. Pipe publications still wake this wait immediately.
        const milliseconds = Math.min(remaining, 10);
        const expected = sequence;
        if (this.options.wait) this.options.wait(milliseconds, word, expected);
        else controlWait(word, 0, expected, milliseconds);
      }
    } finally {
      for (let index = unregister.length - 1; index >= 0; index--) unregister[index]!();
    }
  }
}
