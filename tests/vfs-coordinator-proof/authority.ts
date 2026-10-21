import { openDatabase, initial, transaction } from "./database.js";
import { perform, bumpVersions, enforceBounds } from "./filesystem.js";
import {
  cursor,
  checkRequestBytes,
  failure,
  mutation,
  type Command,
  type Envelope,
  type Reply,
  type Request,
  type State,
} from "./protocol.js";

let state: State | undefined;
let db: IDBDatabase | undefined;
let stopped = false;
let tail = Promise.resolve();
let pending = 0;
let unlock: (() => void) | undefined;
const gates = new Map<string, () => void>();
let instance = crypto.randomUUID();
let workspaceName: string | undefined;
const events: unknown[] = [];
const ports = new Set<MessagePort>();
const counters = {
  strict: 0,
  relaxed: 0,
  memoryAcks: 0,
  mutations: 0,
  duplicate: 0,
  fenced: 0,
  pendingPeak: 0,
  rejected: 0,
};

function post(
  port: MessagePort,
  message: { id?: number; result?: Reply; nudge?: boolean; diagnostic?: unknown },
  from = instance,
): void {
  port.postMessage({ ...message, instance: from });
}
function greet(): void {
  for (const port of ports) port.postMessage({ hello: instance });
}
function replaceInstance(): void {
  unlock?.();
  unlock = undefined;
  db?.close();
  db = undefined;
  state = undefined;
  workspaceName = undefined;
  stopped = false;
  pending = 0;
  tail = Promise.resolve();
  instance = crypto.randomUUID();
  greet();
}
function trace(event: unknown): void {
  if (new URL(location.href).searchParams.has("trace")) {
    const diagnostic = { instance, time: performance.now(), event };
    for (const port of ports) post(port, { diagnostic });
  }
  events.push(event);
  if (events.length > 256) events.shift();
}
function current(): State {
  if (!state || !db) throw new Error("UNAVAILABLE: uninitialized authority");
  if (stopped) throw new Error("FENCED: closed authority");
  return state;
}
function database(): IDBDatabase {
  if (!db) throw new Error("UNAVAILABLE: no database");
  return db;
}
function fence(head: State | undefined): State {
  const local = current();
  if (!head || head.epoch !== local.epoch || head.token !== local.token || head.closed) {
    counters.fenced++;
    throw new Error("FENCED: obsolete authority");
  }
  return head;
}
function requireInstance(expected: string): void {
  if (instance !== expected) throw new Error("FENCED: instance changed across await");
}
async function acquireVolatile(workspace: string): Promise<() => void> {
  const ready = Promise.withResolvers<(() => void) | undefined>();
  void navigator.locks.request(`e5-volatile:${workspace}`, { ifAvailable: true }, (lock) => {
    trace({ phase: "volatile-lock-result", acquired: Boolean(lock), instance });
    if (!lock) {
      ready.resolve(undefined);
      return;
    }
    return new Promise<void>((resolve) => ready.resolve(resolve));
  });
  const release = await ready.promise;
  if (!release) throw new Error("UNAVAILABLE: live lock-holding volatile authority");
  return release;
}
async function initialize(command: Extract<Command, { kind: "initialize" }>): Promise<Reply> {
  const from = instance;
  if (state) {
    const local = current();
    if (
      workspaceName !== command.workspace ||
      local.arm !== command.arm ||
      local.token !== command.token
    )
      throw new Error("FENCED: initialized authority identity mismatch");
    await transaction(database(), "relaxed", (head) => ({ result: fence(head) }));
    requireInstance(from);
    if (local !== current()) throw new Error("FENCED: initialize changed across await");
    counters.relaxed++;
    return { kind: "ok", cursor: cursor(local), result: "already initialized" };
  }
  let claimedDatabase: IDBDatabase | undefined;
  let release: (() => void) | undefined;
  try {
    if (command.arm === "volatile-fast") release = await acquireVolatile(command.workspace);
    requireInstance(from);
    claimedDatabase = await openDatabase(command.workspace);
    requireInstance(from);
    const claimed = await transaction(claimedDatabase, "strict", (saved) => {
      requireInstance(from);
      return claim(saved, command);
    });
    requireInstance(from);
    db = claimedDatabase;
    unlock = release;
    state = claimed;
    workspaceName = command.workspace;
  } catch (error) {
    release?.();
    claimedDatabase?.close();
    throw error;
  }
  counters.strict++;
  trace({ phase: "claimed", cursor: cursor(state), token: state.token });
  return { kind: "ok", cursor: cursor(state), result: state.token };
}
function claim(saved: State | undefined, command: Extract<Command, { kind: "initialize" }>) {
  const next = saved ?? initial(command.arm);
  if (next.epoch !== command.expected || next.arm !== command.arm)
    throw new Error("FENCED: claim raced");
  next.epoch++;
  next.token = command.token;
  next.closed = false;
  if (saved && command.arm !== "fenced-safe") {
    next.history = crypto.randomUUID();
    next.changes = [];
  }
  next.durableWatermark = next.watermark;
  return { state: next, result: next };
}
function checkRequest(request: Request, head: State): void {
  if (request.epoch !== head.epoch) throw new Error("FENCED: request epoch");
  if (request.expiresAt !== undefined && Date.now() >= request.expiresAt)
    throw new Error("UNAVAILABLE: request expired before admission");
  checkRequestBytes(request);
}
function history(request: Request, head: State): void {
  if (request.history !== head.history) throw new Error("OUTCOME_UNKNOWN: history reset");
}
function read(head: State, request: Request): unknown {
  history(request, head);
  const operation = request.operation;
  if (operation.kind === "status") return head.receipts.get(operation.key) ?? null;
  if (operation.kind !== "changes") return perform(head, operation);
  const oldest = head.changes[0]?.watermark ?? head.watermark + 1;
  if (
    operation.history !== head.history ||
    operation.after < oldest - 1 ||
    operation.after > head.watermark
  )
    return { kind: "gap", oldest, resync: "snapshot", cursor: cursor(head) };
  return {
    kind: "batch",
    changes: head.changes.filter((change) => change.watermark > operation.after),
    cursor: cursor(head),
  };
}
function apply(head: State, request: Request): { state: State; result: unknown } {
  checkRequest(request, head);
  const key = `${request.client}:${request.sequence}`;
  const fingerprint = JSON.stringify({ actor: request.actor, operation: request.operation });
  const receipt = head.receipts.get(key);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new Error("OP_ID_CONFLICT: payload mismatch");
    counters.duplicate++;
    return { state: head, result: receipt };
  }
  history(request, head);
  if (head.receipts.size >= 256) throw new Error("BACKPRESSURE: receipt budget");
  const next = structuredClone(head);
  const operationResult = perform(next, request.operation);
  bumpVersions(head, next);
  enforceBounds(next);
  next.generation++;
  next.watermark++;
  if (next.arm === "fenced-safe") next.durableWatermark = next.watermark;
  const result = request.operation.kind === "guest" ? operationResult : resultAt(next, request);
  const committed = { ...cursor(next), key, fingerprint, result };
  next.receipts.set(key, committed);
  next.changes = next.changes
    .concat([{ ...cursor(next), key, actor: request.actor, operation: request.operation }])
    .slice(-64);
  counters.mutations++;
  return { state: next, result: committed };
}
function resultAt(next: State, request: Request): unknown {
  const operation = request.operation;
  if (operation.kind === "write" || operation.kind === "append")
    return perform(next, { kind: "read", path: operation.path });
  if (operation.kind === "rename") return perform(next, { kind: "read", path: operation.to });
  throw new Error("INVALID: mutation");
}
async function checkpoint(): Promise<Reply> {
  const from = instance;
  const local = current();
  const saved = await transaction(database(), "strict", (head) => {
    requireInstance(from);
    fence(head);
    const next = structuredClone(local);
    next.durableWatermark = next.watermark;
    return { state: next, result: next };
  });
  requireInstance(from);
  counters.strict++;
  state = saved;
  return { kind: "ok", cursor: cursor(saved), result: "checkpoint" };
}
async function execute(request: Request): Promise<Reply> {
  const from = instance;
  current();
  if (request.gate) await park(request.gate);
  requireInstance(from);
  const local = current();
  trace({ phase: "admit", key: `${request.client}:${request.sequence}`, epoch: request.epoch });
  if (request.operation.kind === "checkpoint") {
    checkRequest(request, local);
    history(request, local);
    return checkpoint();
  }
  if (local.arm === "volatile-fast") return memoryRequest(local, request);
  const durability = local.arm === "fenced-safe" ? "strict" : "relaxed";
  const result = await transaction(database(), durability, (saved) => {
    requireInstance(from);
    return fencedRequest(saved, request);
  });
  requireInstance(from);
  counters[durability]++;
  state = result.head;
  announce(request);
  return { kind: "ok", cursor: cursor(result.head), result: result.value };
}
function fencedRequest(saved: State | undefined, request: Request) {
  const head = fence(saved);
  checkRequest(request, head);
  if (!mutation(request.operation)) return { result: { head, value: read(head, request) } };
  const next = apply(head, request);
  return { state: next.state, result: { head: next.state, value: next.result } };
}
function memoryRequest(local: State, request: Request): Reply {
  checkRequest(request, local);
  if (!mutation(request.operation))
    return { kind: "ok", cursor: cursor(local), result: read(local, request) };
  const next = apply(local, request);
  state = next.state;
  counters.memoryAcks++;
  announce(request);
  return { kind: "ok", cursor: cursor(next.state), result: next.result };
}
function announce(request: Request): void {
  if (request.dropNudge) return;
  for (const port of ports) post(port, { nudge: true });
}
function park(gate: string): Promise<void> {
  trace({ phase: "parked", gate });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      gates.delete(gate);
      resolve();
    }, 5000);
    gates.set(gate, () => {
      clearTimeout(timer);
      gates.delete(gate);
      resolve();
    });
  });
}
async function drain(): Promise<Reply> {
  const from = instance;
  const result = await checkpoint();
  requireInstance(from);
  await transaction(database(), "strict", (head) => {
    requireInstance(from);
    const next = fence(head);
    next.closed = true;
    return { state: next, result: undefined };
  });
  requireInstance(from);
  stopped = true;
  unlock?.();
  db?.close();
  return result;
}
async function close(): Promise<Reply> {
  const result = await drain();
  setTimeout(() => Reflect.get(globalThis, "close")(), 0);
  return result;
}
async function command(command: Command): Promise<Reply> {
  if (command.kind === "initialize") return initialize(command);
  if (command.kind === "request") return execute(command.request);
  if (command.kind === "close") return close();
  if (command.kind === "drain-instance") return drain();
  throw new Error("INVALID: queued control");
}
async function response(control: Command, result: Reply): Promise<Reply> {
  const from = instance;
  if (control.kind !== "request" || result.kind !== "ok") return result;
  if (control.request.replyGate) await park(control.request.replyGate);
  requireInstance(from);
  const local = current();
  checkRequest(control.request, local);
  if (local.arm !== "volatile-fast") {
    await transaction(database(), "relaxed", (saved) => {
      requireInstance(from);
      return { result: fence(saved) };
    });
    requireInstance(from);
    counters.relaxed++;
  }
  return result;
}
function deliver(port: MessagePort, envelope: Envelope): void {
  const control = envelope.command;
  trace({ phase: "deliver", id: envelope.id, control, initialized: Boolean(state), pending });
  const deliveredInstance = instance;
  if (control.kind === "replace-instance") {
    if (pending > 0 && gates.size === 0) {
      post(port, {
        id: envelope.id,
        result: failure(new Error("UNAVAILABLE: not at deterministic replacement boundary")),
      });
      return;
    }
    post(port, {
      id: envelope.id,
      result: { kind: "ok", cursor: cursor(current()), result: "explicit discard, not freeze" },
    });
    replaceInstance();
    return;
  }
  if (control.kind === "release") {
    gates.get(control.gate)?.();
    post(port, {
      id: envelope.id,
      result: { kind: "ok", cursor: cursor(current()), result: "released" },
    });
    return;
  }
  if (control.kind === "inspect") {
    post(port, {
      id: envelope.id,
      result: {
        kind: "ok",
        cursor: cursor(state ?? initial("fenced-safe")),
        result: { instance, initialized: Boolean(state), events, counters },
      },
    });
    return;
  }
  if (control.kind === "die") {
    Reflect.get(globalThis, "close")();
    return;
  }
  if (pending >= 32) {
    counters.rejected++;
    post(port, {
      id: envelope.id,
      result: failure(new Error("BACKPRESSURE: pending budget")),
    });
    return;
  }
  pending++;
  counters.pendingPeak = Math.max(counters.pendingPeak, pending);
  tail = tail.then(async () => {
    trace({ phase: "queue-start", id: envelope.id, kind: control.kind });
    const committed =
      deliveredInstance === instance
        ? await command(control).catch(failure)
        : failure(new Error("FENCED: retired queue"));
    const result =
      deliveredInstance === instance
        ? await response(control, committed).catch(failure)
        : failure(new Error("FENCED: retired response"));
    if (deliveredInstance === instance) pending--;
    trace({ phase: "reply", result: result.kind === "ok" ? result.cursor : result });
    if (control.kind === "request" && control.request.dropReply) return;
    post(port, { id: envelope.id, result }, deliveredInstance);
    if (control.kind === "drain-instance" && result.kind === "ok") replaceInstance();
    trace({ phase: "posted", id: envelope.id, kind: control.kind });
  });
}
Reflect.set(globalThis, "onconnect", (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  if (ports.size >= 8) {
    port.onmessage = (message: MessageEvent<Envelope>) =>
      post(port, {
        id: message.data.id,
        result: failure(new Error("BACKPRESSURE: port budget")),
      });
    port.start();
    return;
  }
  ports.add(port);
  port.postMessage({ hello: instance });
  trace({ phase: "connected", instance, ports: ports.size });
  port.onmessage = (message: MessageEvent<Envelope>) => deliver(port, message.data);
  port.start();
});
