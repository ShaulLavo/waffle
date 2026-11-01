import { DescriptorTable, type Descriptor, type Resource } from "../core/descriptors.ts";
import { FilesystemError } from "../core/filesystem.ts";
import {
  claimFileOffset,
  shareFileResource,
  type AsyncFileOffsetLease,
} from "../core/open-file.ts";
import {
  RIGHT_FD_READ,
  RIGHT_FD_WRITE,
  RIGHT_FD_SEEK,
  RIGHT_FD_TELL,
  RIGHT_FD_FILESTAT_GET,
} from "../core/rights.ts";
import { FilesystemClient, type FilesystemCompletion } from "../fs/client.ts";
import { PAGE, revokeFilesystem } from "../fs/protocol.ts";
import { waitForFilesystemTransportRetirement } from "../fs/request-memory.ts";
import { atomicsLoad, atomicsWaitAsync } from "../proc/intrinsics.ts";
import type { CallKey, GuestSpan, ThreadOperation, ThreadResult } from "./protocol.ts";

type FileResource = Extract<Resource, { kind: "file" }>;
interface Operation {
  readonly pin: Descriptor;
  readonly request: ThreadOperation;
  readonly completions: Set<FilesystemCompletion>;
  retained: boolean;
}

/** Internal embedding only. Its owner must drain before the filesystem reap fence. */
export class ThreadService {
  private readonly active = new Set<Promise<ThreadResult>>();
  private readonly operations = new Set<Operation>();
  private readonly lanes = new Map<number, number>();
  private readonly tails = new WeakMap<Resource, Promise<unknown>>();
  private readonly cancelled = Promise.withResolvers<void>();
  private phase: "open" | "draining" = "open";
  private retirement: Promise<void> | undefined;

  constructor(
    private readonly options: Readonly<{
      directory: string;
      pid: number;
      memory: WebAssembly.Memory;
      filesystem: FilesystemClient;
      descriptors: DescriptorTable;
    }>,
  ) {}

  submit(call: CallKey, request: ThreadOperation): Promise<ThreadResult> {
    if (this.phase !== "open") return Promise.resolve({ kind: "error", errno: 11 });
    this.admit(call);
    const pin = this.options.descriptors.get(request.fd);
    if (!pin) return Promise.resolve({ kind: "error", errno: 8 });
    if (request.kind === "close") {
      this.options.descriptors.close(request.fd);
      return Promise.resolve({ kind: "ok", value: 0 });
    }
    let copied: ThreadOperation;
    try {
      copied = this.copyRequest(request);
    } catch (error) {
      return Promise.resolve(this.ioError(error));
    }
    pin.description.retain();
    const operation: Operation = {
      pin: { ...pin },
      request: copied,
      completions: new Set(),
      retained: false,
    };
    this.operations.add(operation);
    const result = this.run(operation).finally(() => {
      if (!operation.retained) {
        this.operations.delete(operation);
        pin.description.drop();
      }
    });
    this.active.add(result);
    void result.then(
      () => this.active.delete(result),
      () => this.active.delete(result),
    );
    return result;
  }

  cancelAll(): void {
    if (this.phase !== "open") return;
    this.phase = "draining";
    revokeFilesystem(this.options.filesystem.connection);
    this.cancelled.resolve();
    this.retirement = waitForFilesystemTransportRetirement(this.options.filesystem.connection);
    void this.retirement.catch(() => {});
    for (const operation of this.operations) this.cancelCompletions(operation);
  }

  async drain(): Promise<void> {
    if (this.phase === "open") throw new Error("thread service admission is not sealed");
    const results = await Promise.allSettled(Array.from(this.active));
    await this.retirement;
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private admit({ thread, sequence }: CallKey): void {
    if (thread.directory !== this.options.directory || thread.pid !== this.options.pid)
      throw new Error("foreign thread service call");
    if (
      !Number.isSafeInteger(thread.tid) ||
      thread.tid < 0 ||
      !Number.isSafeInteger(sequence) ||
      sequence <= (this.lanes.get(thread.tid) ?? 0)
    )
      throw new Error("stale thread service call");
    this.lanes.set(thread.tid, sequence);
  }

  private copyRequest(request: ThreadOperation): ThreadOperation {
    if (request.kind !== "read" && request.kind !== "write") return { ...request };
    const spans = request.spans.map(({ address, length }) => {
      this.span({ address, length });
      return { address, length };
    });
    if (request.position !== undefined) this.position(request.position);
    return { ...request, spans };
  }

  private async run(operation: Operation): Promise<ThreadResult> {
    try {
      this.live();
      this.rights(operation);
      if (operation.pin.resource.kind !== "file") return await this.stream(operation);
      const resource = operation.pin.resource;
      shareFileResource(resource, this.options.filesystem.connection);
      if (operation.request.kind === "stat")
        return { kind: "ok", value: await this.request(operation, "stat", [resource.handle]) };
      if ("position" in operation.request && operation.request.position !== undefined)
        return await this.file(operation, resource, operation.request.position);
      const previous = this.tails.get(resource);
      const result = this.sequential(operation, resource, previous);
      this.tails.set(resource, result);
      return await result;
    } catch (error) {
      // A failed remote retirement retains pins and offsets for the aggregate cleanup owner.
      if (this.phase !== "open") await this.retire(operation);
      return this.ioError(error);
    }
  }

  private async sequential(
    operation: Operation,
    resource: FileResource,
    previous?: Promise<unknown>,
  ) {
    await Promise.race([previous?.catch(() => {}), this.cancelled.promise]);
    this.live();
    const lease = await this.offset(resource);
    try {
      return await this.file(operation, resource, lease.position, lease);
    } finally {
      // Revocation can reject value() while remote preparation still owns this operation.
      if (this.phase !== "open") await this.retire(operation);
      lease.release();
    }
  }

  private async offset(resource: FileResource): Promise<AsyncFileOffsetLease> {
    for (;;) {
      this.live();
      const claim = claimFileOffset(resource);
      if (claim.kind === "acquired") return claim.lease;
      if (claim.kind === "failed") throw new FilesystemError(claim.errno);
      await this.wait(claim.word, claim.observed);
    }
  }

  private async file(
    operation: Operation,
    resource: FileResource,
    position: number,
    lease?: AsyncFileOffsetLease,
  ): Promise<ThreadResult> {
    this.live();
    const request = operation.request;
    if (request.kind === "tell") return { kind: "ok", value: position };
    if (request.kind === "seek") {
      const base =
        request.whence === "end"
          ? (await this.request(operation, "stat", [resource.handle])).size
          : request.whence === "current"
            ? position
            : 0;
      const next = base + request.offset;
      this.position(next);
      lease!.commit(next);
      return { kind: "ok", value: next };
    }
    if (request.kind !== "read" && request.kind !== "write") throw new FilesystemError(58);
    const count = Math.min(
      PAGE,
      request.spans.reduce((total, span) => total + span.length, 0),
    );
    if (request.kind === "read") {
      const bytes: Uint8Array = await this.request(operation, "read", [
        resource.handle,
        count,
        position,
      ]);
      lease?.commit(position + bytes.length);
      this.live();
      this.scatter(request.spans, bytes);
      return { kind: "ok", value: bytes.length };
    }
    const data = this.gather(request.spans, count);
    const append = lease?.append === true;
    const result = await this.request(
      operation,
      append ? "append" : "write",
      [resource.handle, position],
      data,
    );
    const written: number = append ? result.written : result;
    lease?.commit(append ? result.offset : position + written);
    this.live();
    return { kind: "ok", value: written };
  }

  private async request(operation: Operation, name: string, args: unknown[], data?: Uint8Array) {
    this.live();
    const completion = this.options.filesystem.submit(name, args, data);
    operation.completions.add(completion);
    try {
      return await completion.value();
    } finally {
      if (this.phase !== "open") await this.retire(operation);
      completion.release();
      operation.completions.delete(completion);
    }
  }

  private async stream(operation: Operation): Promise<ThreadResult> {
    const resource = operation.pin.resource;
    const request = operation.request;
    if (resource.kind === "file" || resource.kind === "directory") throw new FilesystemError(58);
    if (request.kind !== "read" && request.kind !== "write") throw new FilesystemError(58);
    if (request.position !== undefined) throw new FilesystemError(70);
    const attempt = request.kind === "read" ? resource.tryRead : resource.tryWrite;
    if (!attempt) throw new FilesystemError(58);
    for (;;) {
      this.live();
      const observed = resource.notification ? atomicsLoad(resource.notification, 0) : 0;
      const chunks = request.spans.map((span) => this.span(span));
      const result = attempt.call(resource, chunks);
      if (result !== -6)
        return result < 0 ? { kind: "error", errno: -result } : { kind: "ok", value: result };
      if (!resource.notification) throw new FilesystemError(58);
      await this.wait(resource.notification, observed);
    }
  }

  private async wait(word: Int32Array, observed: number): Promise<void> {
    const waiting = atomicsWaitAsync(word, 0, observed, 10);
    if (waiting.async) await Promise.race([waiting.value, this.cancelled.promise]);
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private rights({ pin, request }: Operation): void {
    const right =
      request.kind === "read"
        ? RIGHT_FD_READ
        : request.kind === "write"
          ? RIGHT_FD_WRITE
          : request.kind === "tell"
            ? RIGHT_FD_TELL
            : request.kind === "seek"
              ? RIGHT_FD_SEEK
              : RIGHT_FD_FILESTAT_GET;
    if ((pin.rightsBase & right) !== right) throw new FilesystemError(76);
    if (
      "position" in request &&
      request.position !== undefined &&
      !(pin.rightsBase & RIGHT_FD_SEEK)
    )
      throw new FilesystemError(76);
  }

  private span({ address, length }: GuestSpan): Uint8Array {
    const buffer = this.options.memory.buffer;
    if (
      !Number.isSafeInteger(address) ||
      address < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      address > buffer.byteLength - length
    )
      throw new FilesystemError(21);
    return new Uint8Array(buffer, address, length);
  }

  private position(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new FilesystemError(28);
  }

  private gather(spans: readonly GuestSpan[], count: number): Uint8Array {
    const bytes = new Uint8Array(count);
    let at = 0;
    for (const span of spans) {
      const part = this.span(span).subarray(0, count - at);
      bytes.set(part, at);
      at += part.length;
      if (at === count) break;
    }
    return bytes;
  }

  private scatter(spans: readonly GuestSpan[], bytes: Uint8Array): void {
    let at = 0;
    for (const span of spans) {
      const target = this.span(span);
      const part = bytes.subarray(at, at + target.length);
      target.set(part);
      at += part.length;
      if (at === bytes.length) break;
    }
  }

  private async retire(operation: Operation): Promise<void> {
    try {
      await this.retirement;
    } catch (error) {
      operation.retained = true;
      throw error;
    }
  }

  private cancelCompletions(operation: Operation): void {
    for (const completion of operation.completions) completion.cancel();
  }

  private live(): void {
    if (this.phase !== "open") throw new FilesystemError(11);
  }

  private ioError(error: unknown): ThreadResult {
    if (error instanceof FilesystemError) return { kind: "error", errno: error.errno };
    throw error;
  }
}
