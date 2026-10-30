import { atomicsWaitAsync } from "./intrinsics.js";
import type { DescriptorTable, Resource } from "../core/descriptors.js";
import { withFileOffset, shareFileResource } from "../core/open-file.js";
import { FilesystemClient } from "../fs/client.js";
import type { FilesystemConnection } from "../fs/protocol.js";
import { CommandStdioError, type CommandInput, type CommandOutput } from "./command.js";

const READ = 1n << 1n;
const WRITE = 1n << 6n;
const CHUNK = 64 * 1024;

/** Owns every admitted operation, including writes the trusted callback did not await. */
export class CommandStdio {
  readonly stdin: CommandInput;
  readonly stdout: CommandOutput;
  readonly stderr: CommandOutput;
  private readonly filesystem: FilesystemClient | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new WeakMap<object, Promise<unknown>>();

  constructor(
    private readonly descriptors: DescriptorTable,
    private readonly abort: AbortSignal,
    connection: FilesystemConnection | undefined,
  ) {
    this.filesystem = connection ? new FilesystemClient(connection) : undefined;
    if (connection)
      for (const reservation of connection.reservations) this.filesystem!.adopt(reservation);
    this.stdin = Object.freeze({ read: () => this.admit(0, () => this.read()) });
    this.stdout = this.output(1);
    this.stderr = this.output(2);
  }

  private output(fd: number): CommandOutput {
    return Object.freeze({
      write: (bytes: Uint8Array) => {
        try {
          this.check();
          if (!(bytes instanceof Uint8Array)) throw new TypeError("Expected bytes");
          const owned = new Uint8Array(bytes);
          return this.admit(fd, () => this.write(fd, owned));
        } catch (error) {
          return rejected<void>(error);
        }
      },
    });
  }

  private admit<T>(fd: number, operation: () => Promise<T>): Promise<T> {
    try {
      this.check();
      const descriptor = this.descriptors.get(fd);
      if (!descriptor) throw new CommandStdioError("EBADF");
      const previous = this.queues.get(descriptor.description) ?? Promise.resolve();
      const pending = previous.then(operation, operation);
      this.queues.set(descriptor.description, pending);
      this.pending.add(pending);
      void pending.then(
        () => this.pending.delete(pending),
        () => this.pending.delete(pending),
      );
      return pending;
    } catch (error) {
      return rejected<T>(error);
    }
  }

  private check(): void {
    if (this.abort.aborted) throw new CommandStdioError("CANCELED");
  }

  private resource(fd: number, right: bigint): Exclude<Resource, { kind: "directory" }> {
    this.check();
    const descriptor = this.descriptors.get(fd);
    if (!descriptor || !(descriptor.rightsBase & right)) throw new CommandStdioError("EBADF");
    if (descriptor.resource.kind === "directory") throw new CommandStdioError("EBADF");
    return descriptor.resource;
  }

  private async read(): Promise<Uint8Array | null> {
    const bytes = new Uint8Array(CHUNK);
    const count = await this.transfer(0, bytes, false);
    return count ? bytes.subarray(0, count) : null;
  }

  private async write(fd: number, bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const count = await this.transfer(fd, bytes.subarray(offset, offset + CHUNK), true);
      if (!count) throw new CommandStdioError("EIO", "Output accepted no bytes");
      offset += count;
    }
    this.resource(fd, WRITE);
  }

  private async transfer(fd: number, bytes: Uint8Array, writing: boolean): Promise<number> {
    for (;;) {
      const resource = this.resource(fd, writing ? WRITE : READ);
      const words = this.notifications(resource);
      const observed = words.map((word) => Atomics.load(word, 0));
      const count =
        resource.kind === "file"
          ? this.file(resource, bytes, writing)
          : writing
            ? resource.tryWrite?.([bytes])
            : resource.tryRead?.([bytes]);
      this.check();
      if (count === undefined) throw new CommandStdioError("EIO", "Nonblocking I/O is unavailable");
      if (count >= 0) return count;
      if (count !== -6) throw stdioError(count);
      if (!words.length) throw new CommandStdioError("EIO", "I/O has no readiness notification");
      await this.wait(words, observed);
    }
  }

  private notifications(resource: Resource): Int32Array[] {
    if (resource.kind !== "file")
      return resource.kind === "directory"
        ? []
        : resource.notification
          ? [resource.notification]
          : [];
    const filesystem = this.filesystem;
    if (!filesystem)
      throw new CommandStdioError("EBADF", "File descriptor has no filesystem connection");
    const offset = shareFileResource(resource, filesystem.connection);
    return [new Int32Array(filesystem.connection.signal), new Int32Array(offset, 0, 1)];
  }

  private file(
    resource: Extract<Resource, { kind: "file" }>,
    bytes: Uint8Array,
    writing: boolean,
  ): number {
    const filesystem = this.filesystem;
    if (!filesystem) throw new CommandStdioError("EBADF");
    return withFileOffset(
      resource,
      () => {
        if (writing && resource.append) return this.append(resource, bytes, filesystem);
        const count = writing
          ? filesystem.tryWrite(resource.handle, [bytes], resource.offset)
          : filesystem.tryRead(resource.handle, [bytes], resource.offset);
        if (count > 0) resource.offset += count;
        return count;
      },
      true,
    );
  }

  private append(
    resource: Extract<Resource, { kind: "file" }>,
    bytes: Uint8Array,
    filesystem: FilesystemClient,
  ): number {
    const result = filesystem.tryAppend(resource.handle, [bytes]);
    if (typeof result === "number") return result;
    resource.offset = result.offset;
    return result.written;
  }

  private async wait(words: Int32Array[], observed: number[]): Promise<void> {
    this.check();
    const cancelled = Promise.withResolvers<string>();
    const cancel = () => {
      cancelled.resolve("cancelled");
      for (const word of words) Atomics.notify(word, 0);
    };
    this.abort.addEventListener("abort", cancel, { once: true });
    try {
      const waits = words.map((word, index) => atomicsWaitAsync(word, 0, observed[index]!).value);
      if (this.abort.aborted) cancel();
      await Promise.race(waits.concat([cancelled.promise]));
      for (const word of words) Atomics.notify(word, 0);
      this.check();
    } finally {
      this.abort.removeEventListener("abort", cancel);
    }
  }

  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(Array.from(this.pending));
    await this.filesystem?.stopResidentPublication();
    this.filesystem?.dispose();
  }
}

function stdioError(result: number): CommandStdioError {
  if (result === -64) return new CommandStdioError("EPIPE");
  if (result === -8 || result === -76) return new CommandStdioError("EBADF");
  if (result === -11) return new CommandStdioError("CANCELED");
  return new CommandStdioError("EIO", `I/O failed with errno ${-result}`);
}

function rejected<T>(error: unknown): Promise<T> {
  const pending = Promise.reject<T>(error);
  void pending.catch(() => {});
  return pending;
}
