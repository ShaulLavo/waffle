import { Int32ArrayConstructor } from "../proc/intrinsics.js";
import { FilesystemClient, type FilesystemCompletion } from "./client.js";
import { localPublication } from "./publication-internal.js";
import { mutationIntent, mutationValue, type MutationId } from "./publication.js";
import type { ResidentSession } from "./publication-grant.js";
import { integer, record, text } from "./publication-attachment.js";
import {
  CAPABILITY_HEADER,
  CAPABILITY_LENGTH,
  CAPABILITY_SLOTS,
  CAPABILITY_WORDS,
  PAGE,
  FilesystemError,
  connectFilesystemIdentity,
  createFilesystemIdentity,
  pack,
  type FilesystemConnection,
  type FilesystemIdentity,
} from "./protocol.js";

export interface WorkspaceHost {
  readonly root: FilesystemIdentity;
  connect(connection: FilesystemConnection): void;
  close(connection: FilesystemConnection): Promise<void>;
  adopt(
    connection: FilesystemConnection,
    reservation: FilesystemIdentity["reservations"][number],
  ): void;
}
interface WorkspaceCall {
  readonly operation: string;
  readonly args: unknown[];
  readonly input: Uint8Array;
  readonly id?: MutationId;
}
const requestBound = PAGE + 8192;

const queryOperations = new Set([
  "stat",
  "permissions",
  "resolve",
  "lookup",
  "readdir",
  "read",
  "grow",
  "sync",
  "flush",
]);

function identity(value: unknown): MutationId {
  const data = record(value);
  return { session: integer(data.session), sequence: integer(data.sequence) };
}
function argumentSize(value: unknown, budget: number, depth = 0): number {
  if (budget < 0 || depth > 4) throw new FilesystemError(6);
  if (value === undefined || value === null || typeof value === "boolean") return 8;
  if (typeof value === "number") {
    integer(value);
    return 24;
  }
  if (typeof value === "string") {
    if (value.length > budget) throw new FilesystemError(6);
    return value.length * 3 + 4;
  }
  if (typeof value !== "object") throw new FilesystemError(28);
  if (value instanceof Map) return mapArgumentSize(value, budget, depth);
  const keys = Object.keys(value);
  if (keys.length > (Array.isArray(value) ? 4096 : 8)) throw new FilesystemError(6);
  let size = 2;
  for (const key of keys) {
    size += key.length + argumentSize(Reflect.get(value, key), budget - size, depth + 1);
    if (size > budget) throw new FilesystemError(6);
  }
  return size;
}
function mapArgumentSize(value: Map<unknown, unknown>, budget: number, depth: number): number {
  if (value.size > 4096) throw new FilesystemError(6);
  let size = 2;
  for (const [key, item] of value) {
    size +=
      argumentSize(key, budget - size, depth + 1) + argumentSize(item, budget - size, depth + 1);
    if (size > budget) throw new FilesystemError(6);
  }
  return size;
}
export function workspaceRequest(
  value: unknown,
  inputBound: number,
  argumentBound: number,
): WorkspaceCall {
  const data = record(value),
    operation = text(data.operation);
  if (!Array.isArray(data.args) || data.args.length > 4) throw new FilesystemError(28);
  if (!(data.input instanceof Uint8Array) || data.input.length > inputBound)
    throw new FilesystemError(6);
  argumentSize(data.args, argumentBound);
  if (pack(data.args).length > argumentBound) throw new FilesystemError(6);
  const args: unknown[] = data.args;
  const intent = mutationIntent(operation, args);
  if (!intent && !queryOperations.has(operation)) throw new FilesystemError(2);
  if (intent)
    return { operation, args, input: data.input, ...(data.id ? { id: identity(data.id) } : {}) };
  if (operation === "lookup") text(args[0]);
  else if (operation !== "flush") integer(args[0]);
  if (operation === "resolve") text(args[1]);
  if (operation === "read") {
    integer(args[1], inputBound);
    integer(args[2]);
  }
  if (operation === "grow") integer(args[1]);
  return { operation, args, input: data.input };
}

/** A service identity is derived from the real authority root. Its observer is never copied. */
export class WorkspacePeer {
  readonly client: FilesystemClient;
  private retained = new Set<number>();
  private pending = new Set<FilesystemCompletion>();
  private identities = new Map<number, MutationId>();
  private stopped = false;
  constructor(
    readonly session: ResidentSession,
    private host: WorkspaceHost,
  ) {
    const root = { ...host.root };
    delete root.publication;
    delete root.residentPublication;
    const local = createFilesystemIdentity(root);
    const publication = host.root.publication;
    if (!publication) throw new FilesystemError(58);
    local.publication = { buffers: publication.buffers, session: session.session };
    const pair = connectFilesystemIdentity(local);
    host.connect(pair.server);
    this.client = new FilesystemClient(pair.client);
  }
  owns(handle: number): boolean {
    return !this.stopped && this.retained.has(handle);
  }
  private holdResults(): number[] {
    const entries = new Int32ArrayConstructor(
      this.client.connection.capabilities,
      0,
      CAPABILITY_LENGTH,
    );
    for (let key = CAPABILITY_HEADER; key < entries.length; key += CAPABILITY_WORDS) {
      const handle = Atomics.load(entries, key);
      if (Atomics.load(entries, key + 1) < 0 || this.retained.has(handle)) continue;
      this.client.retain(handle);
      this.retained.add(handle);
    }
    return Array.from(this.retained);
  }
  adopt(source: WorkspacePeer, handles: readonly number[]): number[] {
    if (this.stopped || this.retained.size + handles.length > CAPABILITY_SLOTS)
      throw new FilesystemError(6);
    for (const handle of handles) if (!source.owns(handle)) throw new FilesystemError(8);
    // Use the real service reservation path, including its exact target identity and pin.
    for (const handle of handles) {
      const reservation = source.client.reserve(handle, this.client.connection);
      this.host.adopt(this.client.connection, reservation);
      this.client.adopt(reservation);
      this.retained.add(handle);
    }
    return Array.from(this.retained);
  }
  next(): MutationId {
    if (this.stopped) throw new FilesystemError(11);
    const id = this.client.shared.publication!.next(this.session.session);
    if (this.identities.size >= this.client.shared.publication!.limits.operations) {
      const oldest = this.identities.keys().next().value;
      if (oldest !== undefined) this.identities.delete(oldest);
    }
    this.identities.set(id.sequence, id);
    return id;
  }
  receipt(value: unknown) {
    return this.client.shared.publication!.lookup(this.session.session, identity(value));
  }
  receipts() {
    return Array.from(this.identities.values(), (id) => ({ id, outcome: this.receipt(id) }));
  }
  async execute(value: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.stopped || signal.aborted) throw new FilesystemError(11);
    const limits = this.client.shared.publication!.limits;
    const call = workspaceRequest(value, limits.inputBytes, limits.argumentBytes);
    const prepared = mutationIntent(call.operation, call.args)
      ? this.client.withMutation(() => this.prepare(call), call.input.length * 3)
      : this.prepare(call);
    if (prepared.kind === "duplicate") return prepared.value;
    const { completion, admission } = prepared;
    const cancel = () => completion.cancel();
    this.pending.add(completion);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const result: unknown = await completion.value();
      argumentSize(result instanceof Uint8Array ? undefined : result, requestBound);
      if (result instanceof Uint8Array && result.length > limits.inputBytes)
        throw new FilesystemError(6);
      const handles = this.holdResults();
      const receipt = admission ? this.receipt(admission.id) : undefined;
      return {
        value: result,
        handles,
        ...(receipt?.kind === "committed" ? { receipt: receipt.receipt } : {}),
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      this.pending.delete(completion);
      completion.release();
    }
  }
  private prepare(call: WorkspaceCall) {
    let admission;
    if (mutationIntent(call.operation, call.args)) {
      const admitted = this.client[localPublication](
        call.operation,
        call.args,
        call.input,
        call.id ?? this.next(),
      );
      if (admitted.kind === "duplicate")
        return {
          kind: "duplicate" as const,
          value: {
            value: mutationValue(admitted.receipt.result),
            receipt: admitted.receipt,
            handles: this.holdResults(),
          },
        };
      admission = admitted.admission;
    }
    const completion = this.client.submit(call.operation, call.args, call.input, PAGE, admission);
    return { kind: "pending" as const, completion, admission };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const completion of this.pending) completion.cancel();
    await this.host.close(this.client.connection);
    this.client.dispose();
    this.retained.clear();
  }
}
