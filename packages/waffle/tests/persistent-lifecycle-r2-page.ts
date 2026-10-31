import { FilesystemClient } from "../fs/client";
import {
  acquirePublicationGuard,
  createResidentConnection,
  integer,
  record,
  residentDescriptor,
  residentSession,
  ResidentChannel,
  text,
} from "../fs/publication-attachment";
import { control as existingControl } from "./publication-cross-tab-browser";

type Outcome =
  | { kind: "pending" }
  | { kind: "fulfilled"; value: unknown }
  | { kind: "rejected"; failure: string; errno: unknown };
const outcomes = new Map<string, Outcome>();
const joins = new Map<string, Promise<void>>();
const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
const messages: Record<string, unknown>[] = [];
let worker: Worker | undefined;
let client: FilesystemClient | undefined;
let wire: BroadcastChannel | undefined;

function rpc(operation: string, body?: unknown): Promise<unknown> {
  if (!worker) throw new Error("owner worker absent");
  const id = crypto.randomUUID(),
    answer = Promise.withResolvers<unknown>();
  pending.set(id, answer);
  worker.postMessage({ id, operation, body });
  return answer.promise;
}
function start(body: unknown): Promise<unknown> {
  if (worker) throw new Error("old owner worker still present");
  worker = new Worker("/persistent-lifecycle-r2-owner.js", { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<unknown>) => {
    const response = record(data),
      id = text(response.id),
      answer = pending.get(id);
    pending.delete(id);
    if (response.failure)
      answer?.reject(Object.assign(new Error(String(response.failure)), { errno: response.errno }));
    else answer?.resolve(response.value);
  };
  return rpc("start", body);
}
function track(key: string, action: () => Promise<unknown>): null {
  if (joins.has(key)) throw new Error(`duplicate tracked operation ${key}`);
  outcomes.set(key, { kind: "pending" });
  joins.set(
    key,
    Promise.resolve()
      .then(action)
      .then(
        (value) => {
          outcomes.set(key, { kind: "fulfilled", value });
        },
        (error: unknown) => {
          outcomes.set(key, {
            kind: "rejected",
            failure: String(error),
            errno: Reflect.get(Object(error), "errno") ?? null,
          });
        },
      ),
  );
  return null;
}
function attached(): FilesystemClient {
  if (!client) throw new Error("borrower absent");
  return client;
}
async function attach(value: unknown): Promise<void> {
  if (client) throw new Error("old borrower still present");
  client = new FilesystemClient(createResidentConnection(residentDescriptor(value)));
  await client.attachResidentPublication();
}
async function stopPeer(): Promise<unknown> {
  const peer = attached();
  await peer.stopResidentPublication();
  peer.dispose();
  client = undefined;
  return { stopped: true };
}
async function host(value: unknown): Promise<unknown> {
  const data = record(value);
  if (!Array.isArray(data.args)) throw new Error("missing host arguments");
  const bytes = Array.isArray(data.bytes) ? Uint8Array.from(data.bytes) : undefined;
  const result: unknown = await attached().asyncCall(text(data.operation), data.args, bytes);
  return result instanceof Uint8Array ? Array.from(result) : result;
}
function begin(body: unknown): null {
  const data = record(body),
    key = text(data.key);
  if (data.kind === "prepare")
    return track(key, () =>
      attached()
        .residentPublicationClient()
        .prepare({ kind: "append", maxBytes: 1 }, integer(data.handle)),
    );
  if (data.kind === "stopPeer") return track(key, stopPeer);
  if (data.kind === "ownerStop") return track(key, () => rpc("stop"));
  if (data.kind === "host") return track(key, () => host(data.body));
  throw new Error("unknown tracked work");
}
function settlementAttempt(channel: ResidentChannel, token: string, outcome: unknown) {
  return channel.call("settle", { token, outcome }).then(
    (value) => ({ kind: "fulfilled", value }),
    (error: unknown) => ({ kind: "rejected", errno: Reflect.get(Object(error), "errno") }),
  );
}
async function staleOutcome(body: unknown): Promise<unknown> {
  const data = record(body),
    descriptor = residentDescriptor(data.descriptor);
  const guard = await acquirePublicationGuard(
    descriptor.workspace,
    "shared",
    new AbortController().signal,
  );
  const channel = new ResidentChannel(descriptor.workspace);
  try {
    const fresh = residentSession(await channel.call("open", descriptor));
    const old = record(data.outcome);
    if (!Array.isArray(old.bytes)) throw new Error("old encoded outcome absent");
    const outcome = { ...old, bytes: Uint8Array.from(old.bytes) };
    const failures = [];
    for (const token of [text(data.token), fresh.token]) {
      failures.push(await settlementAttempt(channel, token, outcome));
    }
    await channel.finish("close", { token: fresh.token });
    return failures;
  } finally {
    channel.close();
    await guard.release();
  }
}
async function acknowledgedTail(): Promise<unknown> {
  const peer = attached(),
    resident = peer.residentPublicationClient();
  const root: number = await peer.asyncCall("preopen", ["/"]);
  const file: { node: number } = await peer.asyncCall("resolve", [root, "saved"]);
  const stat: { size: number } = await peer.asyncCall("stat", [file.node]);
  await peer.asyncCall("grow", [file.node, stat.size + 1]);
  await resident.prepare({ kind: "append", maxBytes: 1 }, file.node);
  const ack = peer.tryAppend(file.node, [new Uint8Array([90])]);
  const original = BroadcastChannel.prototype.postMessage;
  let outcome: unknown;
  BroadcastChannel.prototype.postMessage = function (value: unknown) {
    const message = record(value);
    if (message.kind === "request" && message.operation === "settle")
      outcome = record(message.body).outcome;
    Reflect.apply(original, this, [value]);
  };
  try {
    const settlement = await resident.settle();
    if (settlement.kind !== "committed" || !outcome)
      throw new Error("actual committed outcome missing");
    const encoded = record(outcome);
    if (!(encoded.bytes instanceof Uint8Array)) throw new Error("committed bytes absent");
    return {
      ack,
      outcome: { ...encoded, bytes: Array.from(encoded.bytes) },
      settlement,
      token: resident.session.token,
      id: settlement.receipt.id,
    };
  } finally {
    BroadcastChannel.prototype.postMessage = original;
  }
}
async function staleDescriptor(value: unknown): Promise<unknown> {
  const stale = new FilesystemClient(createResidentConnection(residentDescriptor(value)));
  try {
    await stale.attachResidentPublication();
    return { kind: "attached" };
  } catch (error) {
    return { kind: "rejected", errno: Reflect.get(Object(error), "errno") };
  } finally {
    await stale.stopResidentPublication();
    stale.dispose();
  }
}

function observe(value: unknown): void {
  const descriptor = residentDescriptor(value);
  wire = new BroadcastChannel(`waffle:resident:${descriptor.workspace}`);
  wire.onmessage = ({ data }: MessageEvent<unknown>) => {
    const message = record(data),
      body = message.body;
    const request = body && typeof body === "object" ? record(body) : {};
    messages.push({
      kind: message.kind,
      id: message.id,
      client: message.client,
      operation: message.operation,
      token: request.token,
      errno: message.errno,
    });
  };
}
async function deleteWorkspace(value: unknown): Promise<unknown> {
  wire?.close();
  const request = indexedDB.deleteDatabase(text(value));
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("native deletion blocked"));
  });
  return { deleted: true };
}
/** @browserEntry Native lifecycle controls with an explicit worker owner. */
export async function control(operation: string, body?: unknown): Promise<unknown> {
  if (operation === "start") return start(body);
  if (operation === "refusedStart")
    return start(body).then(
      () => ({ kind: "ready" }),
      (error: unknown) => ({ kind: "rejected", errno: Reflect.get(Object(error), "errno") }),
    );
  if (operation === "owner") {
    const data = record(body);
    return rpc(text(data.operation), data.body);
  }
  if (operation === "terminate") {
    worker?.terminate();
    worker = undefined;
    return null;
  }
  if (operation === "attach") return attach(body);
  if (operation === "host") return host(body);
  if (operation === "stopPeer") return stopPeer();
  if (operation === "begin") return begin(body);
  if (operation === "status") return Object.fromEntries(outcomes);
  if (operation === "join") {
    await joins.get(text(body));
    return outcomes.get(text(body));
  }
  if (operation === "acknowledgedTail") return acknowledgedTail();
  if (operation === "staleDescriptor") return staleDescriptor(body);
  if (operation === "staleOutcome") return staleOutcome(body);
  if (operation === "tryAppend") return attached().tryAppend(integer(body), [new Uint8Array([99])]);
  if (operation === "wire") return observe(body);
  if (operation === "messages") return messages;
  if (operation === "nativeRecords") return existingControl("persistentInspect", body);
  if (operation === "locks") return navigator.locks.query();
  if (operation === "delete") return deleteWorkspace(body);
  throw new Error(`unknown page operation ${operation}`);
}
