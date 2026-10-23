import type { PublicationCut } from "./publication.js";
import { parseStoredIdentity, type StoredIdentity } from "./file-identity.js";
import {
  decodeRecord,
  encodeRecord,
  validInteger,
  type ChecksummedRecord,
  type PersistedIndex,
  type PersistenceBatch,
  type StorageBackend,
} from "./storage.js";
import { VfsError } from "./vfs.js";

export const STAGED_FORMAT = "waffle-indexeddb-staged-v1";
const PROTOCOL = "waffle-staged-commit-v1";
const MAX_COUNTER = (1n << 128n) - 1n;
export const STAGING_LIMITS = {
  bytes: 64 * 1024 * 1024,
  inputBytes: 8 * 1024 * 1024,
  metadataBytes: 1024 * 1024,
  clients: 64,
  receipts: 1024,
};
type CommitSequence = bigint & { readonly __brand: "CommitSequence" };
type ClientToken = bigint & { readonly __brand: "ClientToken" };
type RequestSequence = bigint & { readonly __brand: "RequestSequence" };
export interface OperationKey {
  readonly client: ClientToken;
  readonly sequence: RequestSequence;
}
export interface RequestFingerprint {
  readonly digest: string;
  readonly length: number;
}
interface StoredCommitHead {
  readonly protocol: typeof PROTOCOL;
  readonly workspace: string;
  readonly epoch: number;
  readonly sequence: CommitSequence;
  readonly generation: number;
  readonly root: number;
}
interface DurablePayloadRoot {
  readonly key: string;
  readonly size: number;
}
type StableResult =
  | { readonly kind: "value"; readonly value: number | boolean | null }
  | { readonly kind: "append"; readonly written: number; readonly offset: number }
  | { readonly kind: "file"; readonly identity: StoredIdentity }
  | { readonly kind: "error"; readonly errno: number };
export interface DurableReceipt {
  readonly key: OperationKey;
  readonly request: RequestFingerprint;
  readonly commit: CommitSequence;
  readonly cut: PublicationCut;
  readonly result: StableResult;
  readonly retained: readonly DurablePayloadRoot[];
}
interface ClientWindow {
  readonly client: ClientToken;
  readonly retiredThrough: RequestSequence;
  readonly receipts: readonly DurableReceipt[];
}
export interface CommitEnvelope {
  readonly head: StoredCommitHead;
  readonly previous: CommitSequence;
  readonly nextClient: ClientToken;
  readonly clients: readonly ClientWindow[];
  readonly orphans: readonly DurablePayloadRoot[];
}
export interface CommittedRecovery {
  readonly index: PersistedIndex | undefined;
  readonly envelope: CommitEnvelope;
  readonly epoch: number;
}
export interface PreparedDurableGroup {
  readonly batch: PersistenceBatch;
  readonly expectedHead: StoredCommitHead;
  readonly envelope: ChecksummedRecord;
  readonly receipt: DurableReceipt;
}
export type NativeOutcome =
  | { readonly kind: "committed"; readonly receipt: DurableReceipt }
  | { readonly kind: "aborted"; readonly cause: unknown };
export interface NativeCommit {
  readonly terminal: Promise<NativeOutcome>;
  requestAbort(): void;
}
export interface CommittedStorage extends Pick<
  StorageBackend,
  "read" | "readRange" | "retainPayload" | "close"
> {
  recoverCommitted(): Promise<CommittedRecovery>;
  beginCommit(group: PreparedDurableGroup): NativeCommit;
}
export class StagingCapacity extends Error {
  constructor() {
    super("Staged commit capacity exceeded");
  }
}
export function invalidCommit(): never {
  throw new VfsError("INVALID_VFS_FORMAT", "indexeddb", "Invalid required staged commit head");
}
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidCommit();
  if (Object.keys(value).length !== names.length || names.some((key) => !(key in value)))
    invalidCommit();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256) invalidCommit();
  return value;
}
function integer(value: unknown): number {
  if (!validInteger(value)) invalidCommit();
  return value;
}
function counter(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9a-f][0-9a-f]{0,31})$/.test(value)) invalidCommit();
  return BigInt(`0x${value}`);
}
function commitSequence(value: unknown): CommitSequence {
  return counter(value) as CommitSequence;
}
function clientToken(value: unknown): ClientToken {
  const parsed = counter(value);
  if (!parsed) invalidCommit();
  return parsed as ClientToken;
}
function requestSequence(value: unknown): RequestSequence {
  return counter(value) as RequestSequence;
}
export function operationKey(client: bigint, sequence: bigint): OperationKey {
  const key = {
    client: clientToken(client.toString(16)),
    sequence: requestSequence(sequence.toString(16)),
  };
  if (!key.sequence) invalidCommit();
  return key;
}
function parseKey(value: unknown): OperationKey {
  const key = record(value, ["client", "sequence"]);
  return operationKey(clientToken(key.client), requestSequence(key.sequence));
}
function fingerprint(value: unknown): RequestFingerprint {
  const request = record(value, ["digest", "length"]);
  if (typeof request.digest !== "string" || !/^[a-f0-9]{64}$/.test(request.digest)) invalidCommit();
  return { digest: request.digest, length: integer(request.length) };
}
function roots(value: unknown): DurablePayloadRoot[] {
  if (!Array.isArray(value) || value.length > STAGING_LIMITS.receipts) invalidCommit();
  const seen = new Set<string>();
  return value.map((item) => {
    const root = record(item, ["key", "size"]),
      key = text(root.key);
    if (seen.has(key)) invalidCommit();
    seen.add(key);
    return { key, size: integer(root.size) };
  });
}
function result(value: unknown): StableResult {
  if (!value || typeof value !== "object" || !("kind" in value)) invalidCommit();
  if (value.kind === "append") {
    const append = record(value, ["kind", "written", "offset"]);
    const written = integer(append.written),
      offset = integer(append.offset);
    if (written > offset) invalidCommit();
    return { kind: "append", written, offset };
  }
  if (value.kind === "file")
    return {
      kind: "file",
      identity: parseStoredIdentity(record(value, ["kind", "identity"]).identity),
    };
  if (value.kind === "error")
    return { kind: "error", errno: integer(record(value, ["kind", "errno"]).errno) };
  const item = record(value, ["kind", "value"]);
  if (
    item.kind !== "value" ||
    (item.value !== null &&
      typeof item.value !== "boolean" &&
      (typeof item.value !== "number" || !Number.isSafeInteger(item.value)))
  )
    invalidCommit();
  return { kind: "value", value: item.value };
}
function receipt(value: unknown): DurableReceipt {
  const item = record(value, ["key", "request", "commit", "cut", "result", "retained"]);
  const cut = record(item.cut, ["history", "generation"]);
  return {
    key: parseKey(item.key),
    request: fingerprint(item.request),
    commit: commitSequence(item.commit),
    cut: { history: text(cut.history), generation: integer(cut.generation) },
    result: result(item.result),
    retained: roots(item.retained),
  };
}
function parseHead(value: unknown): StoredCommitHead {
  const head = record(value, ["protocol", "workspace", "epoch", "sequence", "generation", "root"]);
  if (head.protocol !== PROTOCOL) invalidCommit();
  return {
    protocol: PROTOCOL,
    workspace: text(head.workspace),
    epoch: integer(head.epoch),
    sequence: commitSequence(head.sequence),
    generation: integer(head.generation),
    root: integer(head.root),
  };
}
function parseEnvelope(value: unknown): CommitEnvelope {
  const item = record(value, ["head", "previous", "nextClient", "clients", "orphans"]);
  if (!Array.isArray(item.clients) || item.clients.length > STAGING_LIMITS.clients) invalidCommit();
  const head = parseHead(item.head),
    nextClient = clientToken(item.nextClient);
  let count = 0,
    last = 0n;
  const clients = item.clients.map((value): ClientWindow => {
    const entry = record(value, ["client", "retiredThrough", "receipts"]);
    const client = clientToken(entry.client),
      retiredThrough = requestSequence(entry.retiredThrough);
    if (client <= last || client >= nextClient || !Array.isArray(entry.receipts)) invalidCommit();
    last = client;
    count += entry.receipts.length;
    if (count > STAGING_LIMITS.receipts) invalidCommit();
    const receipts = entry.receipts.map(receipt);
    validateWindow(client, retiredThrough, receipts, head.sequence);
    return { client, retiredThrough, receipts };
  });
  const previous = commitSequence(item.previous);
  const orphans = roots(item.orphans);
  if (
    head.sequence === 0n
      ? previous !== 0n ||
        clients.length !== 0 ||
        nextClient !== 1n ||
        head.generation !== 0 ||
        head.root !== 0 ||
        orphans.length !== 0
      : previous + 1n !== head.sequence
  )
    invalidCommit();
  return { head, previous, nextClient, clients, orphans };
}
function validateWindow(
  client: ClientToken,
  floor: RequestSequence,
  receipts: readonly DurableReceipt[],
  head: CommitSequence,
): void {
  let sequence: bigint = floor;
  let commit = 0n;
  for (const item of receipts) {
    if (
      item.key.client !== client ||
      item.key.sequence !== ++sequence ||
      item.commit <= commit ||
      item.commit > head
    )
      invalidCommit();
    commit = item.commit;
  }
}
function wire(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString(16) : item,
  );
}
export async function encodeCommit(envelope: CommitEnvelope): Promise<ChecksummedRecord> {
  const json = wire(envelope);
  if (json.length * 2 > STAGING_LIMITS.metadataBytes) throw new StagingCapacity();
  const canonical = parseEnvelope(JSON.parse(json));
  return encodeRecord(JSON.parse(wire(canonical)));
}
export async function decodeCommit(encoded: unknown): Promise<CommitEnvelope> {
  if (
    !encoded ||
    typeof encoded !== "object" ||
    !("json" in encoded) ||
    typeof encoded.json !== "string" ||
    encoded.json.length * 2 > STAGING_LIMITS.metadataBytes
  )
    invalidCommit();
  const envelope = parseEnvelope(await decodeRecord(encoded));
  if (wire(envelope) !== encoded.json) invalidCommit();
  return envelope;
}
function sameHead(left: StoredCommitHead, right: StoredCommitHead): boolean {
  return wire(left) === wire(right);
}
export function sameRecord(value: unknown, expected: ChecksummedRecord): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "json" in value &&
    "checksum" in value &&
    value.json === expected.json &&
    value.checksum === expected.checksum
  );
}
export function initialEnvelope(epoch: number): CommitEnvelope {
  return {
    head: {
      protocol: PROTOCOL,
      workspace: crypto.randomUUID(),
      epoch,
      sequence: commitSequence("0"),
      generation: 0,
      root: 0,
    },
    previous: commitSequence("0"),
    nextClient: clientToken("1"),
    clients: [],
    orphans: [],
  };
}
export function commitRoots(envelope: CommitEnvelope): Map<string, number> {
  const retained = new Map<string, number>();
  const add = (root: DurablePayloadRoot) => {
    if (retained.has(root.key) && retained.get(root.key) !== root.size) invalidCommit();
    retained.set(root.key, root.size);
  };
  envelope.orphans.forEach(add);
  for (const client of envelope.clients)
    for (const item of client.receipts) item.retained.forEach(add);
  return retained;
}
export type ReceiptLookup =
  | { readonly kind: "retained"; readonly receipt: DurableReceipt }
  | { readonly kind: "retired" | "absent" | "conflict" };
export function lookupReceipt(
  envelope: CommitEnvelope,
  key: OperationKey,
  request: RequestFingerprint,
): ReceiptLookup {
  const client = envelope.clients.find((client) => client.client === key.client);
  if (!client) return { kind: key.client < envelope.nextClient ? "retired" : "absent" };
  if (key.sequence <= client.retiredThrough) return { kind: "retired" };
  const item = client.receipts.find((item) => item.key.sequence === key.sequence);
  if (!item) return { kind: "absent" };
  return item.request.digest === request.digest && item.request.length === request.length
    ? { kind: "retained", receipt: item }
    : { kind: "conflict" };
}
export interface CompleteStage {
  readonly batch: PersistenceBatch;
  readonly cut: PublicationCut;
  readonly result: StableResult;
  readonly retained: readonly DurablePayloadRoot[];
  readonly orphans: readonly DurablePayloadRoot[];
  publish(receipt: DurableReceipt): void;
  release(): void;
}
export async function prepareDurableGroup(
  recovery: CommittedRecovery,
  key: OperationKey,
  request: RequestFingerprint,
  stage: CompleteStage,
  receiptLimit = STAGING_LIMITS.receipts,
): Promise<PreparedDurableGroup> {
  const previous = recovery.envelope;
  validateAdmission(previous, key, request);
  if (
    previous.head.sequence === MAX_COUNTER ||
    !validInteger(stage.batch.generation) ||
    stage.batch.generation <= previous.head.generation
  )
    invalidCommit();
  const sequence = (previous.head.sequence + 1n) as CommitSequence;
  const nextReceipt: DurableReceipt = {
    key,
    request,
    commit: sequence,
    cut: stage.cut,
    result: stage.result,
    retained: stage.retained,
  };
  const clients = previous.clients.map((entry) => ({
    ...entry,
    receipts: Array.from(entry.receipts),
  }));
  let client = clients.find((entry) => entry.client === key.client);
  if (!client) {
    client = { client: key.client, retiredThrough: requestSequence("0"), receipts: [] };
    clients.push(client);
  }
  client.receipts.push(nextReceipt);
  evictReceipts(clients, receiptLimit);
  const envelope: CommitEnvelope = {
    head: {
      ...previous.head,
      epoch: recovery.epoch,
      sequence,
      generation: stage.batch.generation,
      root: stage.batch.root,
    },
    previous: previous.head.sequence,
    nextClient:
      key.client === previous.nextClient
        ? clientToken((key.client + 1n).toString(16))
        : previous.nextClient,
    clients,
    orphans: stage.orphans,
  };
  return {
    batch: stage.batch,
    expectedHead: previous.head,
    envelope: await encodeCommit(envelope),
    receipt: nextReceipt,
  };
}
function evictReceipts(
  clients: { client: ClientToken; retiredThrough: RequestSequence; receipts: DurableReceipt[] }[],
  limit: number,
): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > STAGING_LIMITS.receipts)
    throw new StagingCapacity();
  let count = clients.reduce((sum, client) => sum + client.receipts.length, 0);
  while (count > limit) {
    const oldest = clients
      .filter((client) => client.receipts.length)
      .sort((a, b) => Number(a.receipts[0]!.commit - b.receipts[0]!.commit))[0]!;
    oldest.retiredThrough = oldest.receipts.shift()!.key.sequence;
    count--;
  }
}
function validateAdmission(
  envelope: CommitEnvelope,
  key: OperationKey,
  request: RequestFingerprint,
): void {
  fingerprint(request);
  operationKey(key.client, key.sequence);
  if (envelope.head.sequence === MAX_COUNTER || key.client === MAX_COUNTER)
    throw new StagingCapacity();
  if (lookupReceipt(envelope, key, request).kind !== "absent") invalidCommit();
  const client = envelope.clients.find((client) => client.client === key.client);
  if (!client && (key.client !== envelope.nextClient || key.sequence !== 1n)) invalidCommit();
  if (!client && envelope.clients.length >= STAGING_LIMITS.clients) throw new StagingCapacity();
  const last = client?.receipts.at(-1)?.key.sequence ?? client?.retiredThrough ?? 0n;
  if (key.sequence !== last + 1n) invalidCommit();
}
export async function validateGroup(
  group: PreparedDurableGroup,
  recovery: CommittedRecovery,
): Promise<CommitEnvelope> {
  const next = await decodeCommit(group.envelope);
  const expected = await prepareDurableGroup(
    recovery,
    group.receipt.key,
    group.receipt.request,
    {
      batch: group.batch,
      cut: group.receipt.cut,
      result: group.receipt.result,
      retained: group.receipt.retained,
      orphans: next.orphans,
      publish() {},
      release() {},
    },
    next.clients.reduce((sum, client) => sum + client.receipts.length, 0),
  );
  if (
    !sameHead(group.expectedHead, recovery.envelope.head) ||
    !sameRecord(group.envelope, expected.envelope) ||
    wire(group.receipt) !== wire(expected.receipt)
  )
    invalidCommit();
  return next;
}

export class NativeCommitControl implements NativeCommit {
  private readonly done = Promise.withResolvers<NativeOutcome>();
  readonly terminal = this.done.promise;
  private tx: IDBTransaction | undefined;
  private outcome: NativeOutcome | undefined;
  private abortCause: DOMException | undefined;
  requestAbort(): void {
    this.abortCause ??= new DOMException("Staged commit aborted", "AbortError");
    try {
      this.tx?.abort();
    } catch {
      /* Native completion may already have won. */
    }
  }
  attach(tx: IDBTransaction): void {
    this.tx = tx;
  }
  checkAbort(): void {
    if (this.abortCause) throw this.abortCause;
  }
  committed(receipt: DurableReceipt): void {
    this.outcome = { kind: "committed", receipt };
  }
  aborted(cause: unknown): void {
    this.outcome = { kind: "aborted", cause };
  }
  finish(error?: unknown): void {
    if (!this.outcome && this.tx) throw new Error("Missing native staged terminal event");
    this.done.resolve(this.outcome ?? { kind: "aborted", cause: error });
    this.tx = undefined;
  }
  get abortReason(): unknown {
    return this.abortCause;
  }
  get durable(): boolean {
    return this.outcome?.kind === "committed";
  }
}

interface StageCharge {
  readonly inputBytes: number;
  readonly payloadBytes: number;
  readonly metadataBytes: number;
  readonly publicationBytes: number;
}
export type StagingOutcome =
  | NativeOutcome
  | { readonly kind: "indeterminate"; readonly key: OperationKey; readonly cause: unknown }
  | { readonly kind: "not-admitted"; readonly cause: unknown }
  | { readonly kind: "retired" | "conflict" };
interface Submission {
  readonly key: OperationKey;
  readonly request: RequestFingerprint;
  readonly charge: StageCharge;
  readonly signal?: AbortSignal;
  prepare(recovery: CommittedRecovery): Promise<CompleteStage>;
}
type DriverState =
  | { kind: "ready"; recovery: CommittedRecovery }
  | {
      kind: "busy";
      recovery: CommittedRecovery;
      key: OperationKey;
      request: RequestFingerprint;
      work: Promise<StagingOutcome>;
    }
  | { kind: "stopped"; cause: unknown };
interface StagingObserver {
  readonly work: Promise<StagingOutcome>;
  settle(outcome: StagingOutcome): void;
}
export class StagedCommitDriver {
  private state: DriverState;
  private debtBytes = 0;
  private peakBytes = 0;
  private nativeDebt = 0;
  private readonly observers = new Set<StagingObserver>();
  private constructor(
    private readonly storage: CommittedStorage,
    recovery: CommittedRecovery,
    private readonly limits: typeof STAGING_LIMITS,
  ) {
    this.state = { kind: "ready", recovery };
  }
  static async open(
    storage: CommittedStorage,
    limits: Partial<typeof STAGING_LIMITS> = {},
  ): Promise<StagedCommitDriver> {
    const selected = { ...STAGING_LIMITS, ...limits };
    for (const key of Object.keys(STAGING_LIMITS) as (keyof typeof STAGING_LIMITS)[]) {
      if (!validInteger(selected[key]) || !selected[key] || selected[key] > STAGING_LIMITS[key])
        throw new StagingCapacity();
    }
    return new StagedCommitDriver(storage, await storage.recoverCommitted(), selected);
  }
  resources() {
    return {
      state: this.state.kind,
      debtBytes: this.debtBytes,
      peakBytes: this.peakBytes,
      nativeDebt: this.nativeDebt,
    };
  }
  submit(input: Submission): Promise<StagingOutcome> {
    const submission: Submission = {
      ...input,
      key: { ...input.key },
      request: { ...input.request },
      charge: { ...input.charge },
      prepare: input.prepare.bind(input),
    };
    if (this.state.kind === "busy") return this.joinBusy(submission, this.state);
    if (submission.signal?.aborted)
      return Promise.resolve({ kind: "not-admitted", cause: submission.signal.reason });
    if (this.state.kind === "stopped")
      return Promise.resolve({ kind: "not-admitted", cause: this.state.cause });
    const recovery = this.state.recovery;
    const known = lookupReceipt(recovery.envelope, submission.key, submission.request);
    if (known.kind === "retained")
      return Promise.resolve({ kind: "committed", receipt: structuredClone(known.receipt) });
    if (known.kind !== "absent") return Promise.resolve({ kind: known.kind });
    if (submission.signal && this.observers.size >= this.limits.clients)
      return Promise.resolve({ kind: "not-admitted", cause: new StagingCapacity() });
    try {
      this.admit(submission, recovery);
    } catch (cause) {
      return Promise.resolve({ kind: "not-admitted", cause });
    }
    const done = Promise.withResolvers<StagingOutcome>();
    this.state = {
      kind: "busy",
      recovery,
      key: submission.key,
      request: submission.request,
      work: done.promise,
    };
    const observed = this.observe(done.promise, submission);
    void this.execute(submission, recovery).then(
      (outcome) => this.complete(done, outcome),
      (cause: unknown) => {
        this.state = { kind: "stopped", cause };
        this.complete(done, { kind: "indeterminate", key: submission.key, cause });
      },
    );
    return observed;
  }
  async drain(): Promise<void> {
    if (this.state.kind === "busy") await this.state.work;
    if (this.state.kind === "stopped") throw this.state.cause;
  }
  private joinBusy(
    submission: Submission,
    busy: Extract<DriverState, { kind: "busy" }>,
  ): Promise<StagingOutcome> {
    if (submission.key.client !== busy.key.client || submission.key.sequence !== busy.key.sequence)
      return Promise.resolve({
        kind: "not-admitted",
        cause: submission.signal?.aborted ? submission.signal.reason : new StagingCapacity(),
      });
    if (
      submission.request.digest !== busy.request.digest ||
      submission.request.length !== busy.request.length
    )
      return Promise.resolve({ kind: "conflict" });
    return this.observe(busy.work, submission);
  }
  private admit(submission: Submission, recovery: CommittedRecovery): void {
    validateAdmission(recovery.envelope, submission.key, submission.request);
    if (
      recovery.envelope.clients.length >= this.limits.clients &&
      !recovery.envelope.clients.some((client) => client.client === submission.key.client)
    )
      throw new StagingCapacity();
    const charge = submission.charge;
    if (
      Object.values(charge).some((bytes) => !validInteger(bytes)) ||
      charge.inputBytes > this.limits.inputBytes
    )
      throw new StagingCapacity();
    const metadata = charge.metadataBytes + wire(recovery.index ?? null).length * 2;
    if (metadata > this.limits.metadataBytes) throw new StagingCapacity();
    const total =
      charge.inputBytes +
      charge.payloadBytes * 6 +
      charge.publicationBytes +
      (metadata + this.limits.metadataBytes) * 16;
    if (!Number.isSafeInteger(total) || total > this.limits.bytes) throw new StagingCapacity();
    this.debtBytes = total;
    this.peakBytes = Math.max(this.peakBytes, total);
  }
  private checkStage(stage: CompleteStage, submission: Submission): void {
    const bytes = Array.from(stage.batch.data.values()).reduce(
      (sum, value) => sum + value.byteLength,
      0,
    );
    const metadata =
      wire({
        ...stage.batch,
        data: Array.from(stage.batch.data.keys()),
        cut: stage.cut,
        result: stage.result,
        retained: stage.retained,
        orphans: stage.orphans,
      }).length * 2;
    if (bytes > submission.charge.payloadBytes || metadata > submission.charge.metadataBytes)
      throw new StagingCapacity();
  }
  private async execute(
    submission: Submission,
    recovery: CommittedRecovery,
  ): Promise<StagingOutcome> {
    let stage: CompleteStage | undefined;
    let durable = false;
    let settled: DriverState = { kind: "ready", recovery };
    try {
      stage = await submission.prepare(structuredClone(recovery));
      this.checkStage(stage, submission);
      const group = await prepareDurableGroup(
        recovery,
        submission.key,
        submission.request,
        stage,
        this.limits.receipts,
      );
      if (group.envelope.json.length * 2 > this.limits.metadataBytes) throw new StagingCapacity();
      submission.signal?.throwIfAborted();
      this.nativeDebt = 1;
      const outcome = await this.storage.beginCommit(group).terminal;
      if (outcome.kind === "aborted") return outcome;
      durable = true;
      const recovered = await this.storage.recoverCommitted();
      stage.publish(outcome.receipt);
      settled = { kind: "ready", recovery: recovered };
      return outcome;
    } catch (cause) {
      settled = durable ? { kind: "stopped", cause } : { kind: "ready", recovery };
      return durable
        ? { kind: "indeterminate", key: submission.key, cause }
        : { kind: "aborted", cause };
    } finally {
      try {
        stage?.release();
      } finally {
        this.nativeDebt = 0;
        this.debtBytes = 0;
        this.state = settled;
      }
    }
  }
  private complete(work: PromiseWithResolvers<StagingOutcome>, outcome: StagingOutcome): void {
    work.resolve(outcome);
    for (const observer of this.observers)
      if (observer.work === work.promise) observer.settle(outcome);
  }
  private observe(work: Promise<StagingOutcome>, submission: Submission): Promise<StagingOutcome> {
    const signal = submission.signal;
    if (!signal) return work;
    if (signal.aborted)
      return Promise.resolve({ kind: "indeterminate", key: submission.key, cause: signal.reason });
    if (this.observers.size >= this.limits.clients)
      return Promise.resolve({
        kind: "indeterminate",
        key: submission.key,
        cause: new StagingCapacity(),
      });
    return new Promise((resolve) => {
      const observer: StagingObserver = {
        work,
        settle: (outcome) => {
          if (!this.observers.delete(observer)) return;
          signal.removeEventListener("abort", abort);
          resolve(outcome);
        },
      };
      const abort = () =>
        observer.settle({ kind: "indeterminate", key: submission.key, cause: signal.reason });
      this.observers.add(observer);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
