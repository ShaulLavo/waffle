import { FilesystemClient } from "./client.js";
import { FilesystemService } from "./service.js";
import type { MemoryBackend } from "./backend.js";
import {
  MemoryBudgetError,
  type MemoryBudget,
  type MemoryLease,
  type MemoryReference,
} from "./memory-budget.js";
import { createFilesystemConnection, filesystemOwnerPlan } from "./protocol.js";
import type { PublicationConfiguration } from "./publication-internal.js";

const published = new WeakMap<MemoryBudget, Set<SharedArrayBuffer>>();
const NativeSharedBuffer = SharedArrayBuffer;
type LocalPair = {
  readonly connection: ReturnType<typeof createFilesystemConnection>;
  readonly root: FilesystemClient;
  readonly service: FilesystemService;
};

/** Owns private construction until attachment, then retains escaped capacity for budget lifetime. */
export class ResidentConstruction {
  private readonly lease: MemoryLease;
  private readonly references: MemoryReference[] = [];
  private readonly buffers: SharedArrayBuffer[] = [];
  private phase: "private" | "published" | "closed" = "private";
  private connection: ReturnType<typeof createFilesystemConnection> | undefined;
  private pair: LocalPair | undefined;
  constructor(
    private readonly memory: MemoryBudget,
    private readonly publication: PublicationConfiguration,
    private readonly checkLive: () => void,
  ) {
    const admitted = memory.tryOperation(filesystemOwnerPlan(publication));
    if (admitted.kind === "stopped") throw new MemoryBudgetError("closed");
    if (admitted.kind === "exhausted") throw new MemoryBudgetError("serial");
    if (admitted.kind !== "granted") throw new MemoryBudgetError("capacity");
    this.lease = admitted.lease;
  }
  private allocateShared(bytes: number, maximum = bytes): SharedArrayBuffer {
    this.checkLive();
    const allocation = this.lease.allocate({ kind: "shared", bytes, maximum });
    this.references.push(allocation.ref);
    const buffer = allocation.backing.buffer;
    if (!(buffer instanceof NativeSharedBuffer)) throw new TypeError("shared backing required");
    this.buffers.push(buffer);
    return buffer;
  }
  attach(backend: MemoryBackend): LocalPair {
    if (this.phase !== "private" || this.connection) throw new MemoryBudgetError("closed");
    if (backend.shared.startupMemoryBudget !== this.memory)
      throw new TypeError("resident backend must own this admitted startup root");
    const connection = createFilesystemConnection(undefined, this.publication, {
      shared: backend.shared.buffer,
      allocateShared: (bytes, maximum) => this.allocateShared(bytes, maximum),
    });
    this.connection = connection;
    const root = new FilesystemClient(connection.client);
    const service = new FilesystemService(backend);
    this.pair = { connection, root, service };
    this.checkLive();
    let retained = published.get(this.memory);
    if (!retained) {
      retained = new Set();
      published.set(this.memory, retained);
    }
    for (const buffer of this.buffers) retained.add(buffer);
    this.phase = "published";
    this.lease.close();
    service.connect(connection.server);
    return this.pair;
  }
  get service(): FilesystemService | undefined {
    return this.pair?.service;
  }
  dispose(): void {
    if (this.phase === "closed") return;
    this.pair?.root.dispose();
    this.pair?.service.dispose();
    this.connection?.client.port.close();
    this.connection?.server.port.close();
    if (this.connection) {
      this.connection.client.port.onmessage = null;
      this.connection.server.port.onmessage = null;
    }
    this.connection = undefined;
    this.pair = undefined;
    this.buffers.length = 0;
    if (this.phase === "private") {
      for (const reference of this.references) this.lease.release(reference);
      this.lease.close();
    }
    this.references.length = 0;
    this.phase = "closed";
  }
}
