import {
  parseOpfsCloseReply,
  OpfsCloseSetupInvalid,
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
  rawFailures: unknown[];
}
const workers = new Map<string, PageWorker>();
let nextRequest = 0;
function failPending(owner: PageWorker, reason: unknown): void {
  owner.rawFailures.push(reason);
  for (const pending of owner.pending.values()) pending.reject(reason);
  owner.pending.clear();
}
function receive(owner: PageWorker, value: unknown): void {
  try {
    const reply = parseOpfsCloseReply(value);
    const pending = owner.pending.get(reply.id);
    if (!pending) throw new OpfsCloseSetupInvalid("Unowned or duplicate Worker reply");
    owner.pending.delete(reply.id);
    pending.resolve(reply);
  } catch (reason) {
    failPending(owner, reason);
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
  original.addEventListener("error", (event) => failPending(owner, event.error));
  original.addEventListener("messageerror", (event) => failPending(owner, event));
}
function request(token: string, command: OpfsCloseCommand): Promise<OpfsCloseReply> {
  const owner = workers.get(token);
  if (!owner) return Promise.reject(new OpfsCloseSetupInvalid("Original Worker missing"));
  if (owner.rawFailures.length) return Promise.reject(owner.rawFailures[0]);
  const id = ++nextRequest;
  const result = new Promise<OpfsCloseReply>((resolve, reject) => {
    owner.pending.set(id, { resolve, reject });
  });
  try {
    owner.original.postMessage({ id, command });
  } catch (reason) {
    failPending(owner, reason);
  }
  return result;
}
function terminateAll(): string[] {
  const interventions: string[] = [];
  for (const [token, owner] of workers) {
    interventions.push(`explicit Worker.terminate:${token}`);
    owner.original.terminate();
    failPending(owner, new Error(`Explicit termination intervention: ${token}`));
  }
  return interventions;
}
window.opfsClose = { start, request, terminateAll };
