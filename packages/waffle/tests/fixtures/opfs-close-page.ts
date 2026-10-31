import {
  parseOpfsCloseReply,
  OpfsCloseSetupInvalid,
  reasonReceipt,
  type OpfsCloseObserverFailure,
  type OpfsCloseCommand,
  type OpfsCloseReply,
} from "../opfs-close-browser.js";

interface Pending {
  resolve(reply: OpfsCloseReply): void;
  reject(reason: unknown): void;
}
interface PageWorker {
  original: Worker;
  pending: Map<number, Pending>;
  rawFailures: { event: OpfsCloseObserverFailure["event"]; reason: unknown }[];
  cancellation?: { reason: unknown };
}
const workers = new Map<string, PageWorker>();
let nextRequest = 0;
function rejectPending(owner: PageWorker, reason: unknown): void {
  for (const pending of owner.pending.values()) pending.reject(reason);
  owner.pending.clear();
}
function failPending(
  owner: PageWorker,
  reason: unknown,
  event: OpfsCloseObserverFailure["event"],
): void {
  owner.rawFailures.push({ event, reason });
  rejectPending(owner, reason);
}
function receive(owner: PageWorker, value: unknown): void {
  try {
    const reply = parseOpfsCloseReply(value);
    const pending = owner.pending.get(reply.id);
    if (!pending) throw new OpfsCloseSetupInvalid("Unowned or duplicate Worker reply");
    owner.pending.delete(reply.id);
    pending.resolve(reply);
  } catch (reason) {
    failPending(owner, reason, "reply");
  }
}
function start(token: string): void {
  if (workers.has(token)) throw new OpfsCloseSetupInvalid("Worker token already owned");
  const original = new Worker(`/opfs-close-worker.js?token=${encodeURIComponent(token)}`, {
    type: "module",
  });
  const owner: PageWorker = { original, pending: new Map(), rawFailures: [] };
  workers.set(token, owner);
  original.addEventListener("message", (event: MessageEvent<unknown>) =>
    receive(owner, event.data),
  );
  original.addEventListener("error", (event) => failPending(owner, event.error, "error"));
  original.addEventListener("messageerror", (event) => failPending(owner, event, "messageerror"));
}
function request(token: string, command: OpfsCloseCommand): Promise<OpfsCloseReply> {
  const owner = workers.get(token);
  if (!owner) return Promise.reject(new OpfsCloseSetupInvalid("Original Worker missing"));
  const failure = owner.rawFailures[0];
  if (failure) return Promise.reject(failure.reason);
  if (owner.cancellation) return Promise.reject(owner.cancellation.reason);
  const id = ++nextRequest;
  const result = new Promise<OpfsCloseReply>((resolve, reject) => {
    owner.pending.set(id, { resolve, reject });
  });
  try {
    owner.original.postMessage({ id, command });
  } catch (reason) {
    failPending(owner, reason, "postMessage");
  }
  return result;
}
function terminateAll(): string[] {
  const interventions: string[] = [];
  for (const [token, owner] of workers) {
    interventions.push(`explicit Worker.terminate:${token}`);
    try {
      owner.original.terminate();
    } catch (reason) {
      failPending(owner, reason, "terminate");
    }
    owner.cancellation = { reason: new Error(`Explicit termination intervention: ${token}`) };
    rejectPending(owner, owner.cancellation.reason);
  }
  return interventions;
}
function failures(): OpfsCloseObserverFailure[] {
  return Array.from(workers, ([token, owner]) =>
    owner.rawFailures.map(({ event, reason }) => ({ token, event, reason: reasonReceipt(reason) })),
  ).flat();
}
window.opfsClose = { start, request, terminateAll, failures };
