import { FilesystemClient } from "../fs/client";
import {
  createResidentConnection,
  integer,
  record,
  residentDescriptor,
  text,
} from "../fs/publication-attachment";
import type { ResidentDescriptor } from "../fs/publication-grant";
import type { FilesystemConnection } from "../fs/protocol";

type Outcome =
  | { kind: "pending"; started: number }
  | { kind: "fulfilled"; started: number; elapsed: number; value: unknown }
  | { kind: "rejected"; started: number; elapsed: number; failure: string; errno: unknown };
const operations = new Map<string, Outcome>();
const debts = new Map<string, Promise<void>>();
const workers = new Map<string, Worker>();
const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
const events = new Map<string, unknown>();
let client: FilesystemClient | undefined;
let descriptor: ResidentDescriptor | undefined;
let pulse: Int32Array | undefined;
let wire: BroadcastChannel | undefined;
const messages: unknown[] = [];

function receive(key: string, value: unknown): void {
  const data = record(value);
  if (typeof data.event === "string") events.set(`${key}:${data.event}`, data);
  if (typeof data.type === "string") events.set(`${key}:${data.type}`, data);
  if (typeof data.id !== "string") return;
  const answer = pending.get(data.id);
  pending.delete(data.id);
  if (data.failure) answer?.reject(new Error(String(data.failure)));
  else answer?.resolve(data.value);
}
function worker(key: string, path: string): Worker {
  if (workers.has(key)) throw new Error(`duplicate worker ${key}`);
  const result = new Worker(new URL(path, location.href), { type: "module", name: key });
  workers.set(key, result);
  result.onmessage = ({ data }: MessageEvent<unknown>) => receive(key, data);
  result.onerror = (error) => events.set(`${key}:failure`, { failure: error.message });
  return result;
}
function rpc(key: string, operation: string, body?: unknown): Promise<unknown> {
  const target = workers.get(key);
  if (!target) throw new Error(`missing worker ${key}`);
  const id = crypto.randomUUID(),
    answer = Promise.withResolvers<unknown>();
  pending.set(id, answer);
  target.postMessage({ id, operation, body });
  return answer.promise;
}
function track(key: string, action: () => Promise<unknown>): void {
  if (operations.has(key)) throw new Error(`duplicate operation ${key}`);
  const started = performance.now();
  operations.set(key, { kind: "pending", started });
  const joined = Promise.resolve()
    .then(action)
    .then(
      (value) =>
        operations.set(key, {
          kind: "fulfilled",
          started,
          elapsed: performance.now() - started,
          value,
        }),
      (error: unknown) =>
        operations.set(key, {
          kind: "rejected",
          started,
          elapsed: performance.now() - started,
          failure: String(error),
          errno: Reflect.get(Object(error), "errno") ?? null,
        }),
    )
    .then(() => {});
  debts.set(key, joined);
}
function host(body: unknown): Promise<unknown> {
  if (!client) throw new Error("page not attached");
  const data = record(body);
  if (!Array.isArray(data.args)) throw new Error("missing host arguments");
  const bytes = Array.isArray(data.bytes) ? Uint8Array.from(data.bytes) : undefined;
  return client
    .asyncCall(text(data.operation), data.args, bytes)
    .then((value: unknown) => (value instanceof Uint8Array ? Array.from(value) : value));
}
async function until(key: string): Promise<unknown> {
  const deadline = performance.now() + 10000;
  while (!events.has(key)) {
    if (performance.now() > deadline) throw new Error(`missing worker event ${key}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return events.get(key);
}
async function startGuest(): Promise<unknown> {
  if (!descriptor) throw new Error("descriptor missing");
  const guest = worker("guest", "/owner-freeze-guest.js");
  const connection: FilesystemConnection = createResidentConnection(descriptor);
  guest.postMessage({ id: crypto.randomUUID(), operation: "start", connection }, [connection.port]);
  return until("guest:ready");
}
async function candidate(name: string): Promise<unknown> {
  worker("candidate", "/owner-freeze-owner.js");
  try {
    const result = await rpc("candidate", "start", { name, pulse: new SharedArrayBuffer(4) }).then(
      (value) => ({ kind: "ready", value }),
      (error: unknown) => ({ kind: "rejected", failure: String(error) }),
    );
    await rpc("candidate", "stop");
    return result;
  } finally {
    workers.get("candidate")!.terminate();
    workers.delete("candidate");
  }
}
function startWire(value: unknown): void {
  const selected = residentDescriptor(value);
  wire = new BroadcastChannel(`waffle:resident:${selected.workspace}`);
  wire.onmessage = ({ data }: MessageEvent<unknown>) => {
    const message = record(data);
    const body = message.body && typeof message.body === "object" ? record(message.body) : {};
    const request = body.request && typeof body.request === "object" ? record(body.request) : {};
    messages.push({
      kind: message.kind,
      id: message.id,
      client: message.client,
      operation: message.operation,
      workspaceOperation: request.operation,
      mutation: request.id,
      errno: message.errno,
      at: performance.now(),
    });
  };
}
async function cleanup(): Promise<unknown> {
  await Promise.all(debts.values());
  const result: Record<string, unknown> = { operations: Object.fromEntries(operations) };
  if (workers.has("guest")) {
    await rpc("guest", "stop");
    result.guestFinished = await until("guest:finished");
    result.guestExit = events.get("guest:exit") ?? null;
    result.guestCleanupError = events.get("guest:cleanup-error") ?? null;
  }
  if (client) {
    result.peer = await client.stopResidentPublication().then(
      () => ({ kind: "stopped" }),
      (error: unknown) => ({ kind: "unresolved", failure: String(error) }),
    );
    client.dispose();
    client = undefined;
  }
  wire?.close();
  result.pendingRpc = pending.size;
  return result;
}

function guestAppend(data: Record<string, unknown>): Promise<unknown> {
  const target = workers.get("guest");
  if (!target) throw new Error("guest missing");
  const id = crypto.randomUUID(),
    answer = Promise.withResolvers<unknown>();
  pending.set(id, answer);
  target.postMessage({ id, operation: "append", byte: integer(data.byte, 255) });
  return answer.promise;
}
function begin(body: unknown): null {
  const data = record(body),
    key = text(data.key);
  if (data.kind === "host") {
    track(key, () => host(data.request));
    return null;
  }
  if (data.kind === "probe") {
    track(key, () => rpc("owner", "probe"));
    return null;
  }
  if (data.kind === "guest") {
    track(key, () => guestAppend(data));
    return null;
  }
  throw new Error("invalid pending work");
}

/** @browserEntry Dedicated native owner freeze control. */
export async function control(operation: string, body?: unknown): Promise<unknown> {
  if (operation === "start") {
    worker("owner", "/owner-freeze-owner.js");
    pulse = new Int32Array(new SharedArrayBuffer(4));
    return rpc("owner", "start", { name: text(body), pulse: pulse.buffer });
  }
  if (operation === "owner") {
    const data = record(body);
    return rpc("owner", text(data.operation), data.body);
  }
  if (operation === "pulse") return Atomics.load(pulse!, 0);
  if (operation === "peer") {
    descriptor = residentDescriptor(body);
    client = new FilesystemClient(createResidentConnection(descriptor));
    await client.attachResidentPublication();
    return null;
  }
  if (operation === "host") return host(body);
  if (operation === "guest") return startGuest();
  if (operation === "candidate") return candidate(text(body));
  if (operation === "wire") return startWire(body);
  if (operation === "messages") return messages;
  if (operation === "status") return Object.fromEntries(operations);
  if (operation === "begin") return begin(body);
  if (operation === "join") {
    await Promise.all(debts.values());
    return Object.fromEntries(operations);
  }
  if (operation === "cleanup") return cleanup();
  if (operation === "delete") {
    const deletion = indexedDB.deleteDatabase(text(body));
    await new Promise<void>((resolve, reject) => {
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
      deletion.onblocked = () => reject(new Error("database deletion blocked"));
    });
    return null;
  }
  throw new Error(`unknown freeze operation ${operation}`);
}
