import {
  createPersistentResidentOwner,
  selectPersistentWorkspace,
  type PersistentResidentOwner,
} from "../../browser/persistent-resident-owner";
import { FilesystemClient } from "../../fs/client";
import { IndexedDBStorage } from "../../fs/indexeddb";
import { publicationObserver } from "../../fs/publication-internal";
import { publicationCut } from "../../fs/publication";
import { integer, record, text } from "../../fs/publication-attachment";

let owner: PersistentResidentOwner | undefined;
let observer: ReturnType<typeof publicationObserver> | undefined;
let holdingReply = false;
let reply: (() => void) | undefined;
let checkpoint: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let checkpointEntered = false;
const events: string[] = [];
const originalCall = FilesystemClient.prototype.asyncCall;
FilesystemClient.prototype.asyncCall = function (...args: Parameters<typeof originalCall>) {
  if (args[0] === "publicationWorkspace") observer = publicationObserver(this);
  return Reflect.apply(originalCall, this, args);
};
const originalPersist = IndexedDBStorage.prototype.persist;
IndexedDBStorage.prototype.persist = async function (...args: Parameters<typeof originalPersist>) {
  if (checkpoint) {
    checkpointEntered = true;
    events.push("checkpoint-held-before-native-persist");
    await checkpoint.promise;
  }
  events.push("native-persist-entered");
  await Reflect.apply(originalPersist, this, args);
  events.push("native-persist-completed");
};
const originalClose = IDBDatabase.prototype.close;
IDBDatabase.prototype.close = function () {
  events.push("native-database-close-called");
  Reflect.apply(originalClose, this, []);
};
const originalPost = BroadcastChannel.prototype.postMessage;
BroadcastChannel.prototype.postMessage = function (value: unknown) {
  const data = record(value);
  const grant = data.value;
  if (
    holdingReply &&
    data.kind === "reply" &&
    grant &&
    typeof grant === "object" &&
    "key" in grant &&
    "session" in grant
  ) {
    holdingReply = false;
    reply = () => Reflect.apply(originalPost, this, [value]);
    events.push("grant-reply-held");
    return;
  }
  Reflect.apply(originalPost, this, [value]);
};
async function execute(operation: string, value: unknown): Promise<unknown> {
  if (operation === "start") {
    const data = record(value);
    const selected = selectPersistentWorkspace({ mode: "fast", name: text(data.name) });
    const base = {
      runtimeLifetime: crypto.randomUUID(),
      attempt: crypto.randomUUID(),
      selected,
      publication: {
        observe: true,
        limits: {
          sessions: 16,
          operations: 32,
          inputBytes: 64,
          argumentBytes: 512,
          effectBytes: 4096,
          effects: 16,
          resultBytes: 256,
          logRecords: 16,
          logBytes: 65536,
          pins: 2,
          pinBytes: 256,
        },
      },
    };
    const original = data.original === undefined ? undefined : record(data.original);
    const request = original
      ? {
          ...base,
          kind: "reopen-v1" as const,
          accept: "new-history-loss-and-unknown" as const,
          original: { instance: text(original.instance), history: text(original.history) },
        }
      : { ...base, kind: "initial-open" as const };
    owner = createPersistentResidentOwner(request, new AbortController().signal);
    return owner.ready;
  }
  if (operation === "stop") {
    if (!owner) throw new Error("owner absent");
    const stopped = owner.stop();
    const memoized = stopped === owner.stop();
    await stopped;
    return { memoized, stopped: true };
  }
  if (operation === "probe") return { checkpointEntered, events: events.slice() };
  if (operation === "holdReply") {
    holdingReply = true;
    return null;
  }
  if (operation === "releaseReply") {
    if (!reply) throw new Error("no held reply");
    reply();
    reply = undefined;
    events.push("grant-reply-released");
    return null;
  }
  if (operation === "holdCheckpoint") {
    checkpoint = Promise.withResolvers<void>();
    checkpointEntered = false;
    return null;
  }
  if (operation === "releaseCheckpoint") {
    checkpoint?.resolve();
    checkpoint = undefined;
    return null;
  }
  if (!observer) throw new Error("factory root not observed");
  if (operation === "cut") return observer.cut();
  if (operation === "changes") return observer.changes(publicationCut(value), 65536);
  if (operation === "receipt") {
    const id = record(value);
    return observer.receipt({ session: integer(id.session), sequence: integer(id.sequence) });
  }
  throw new Error(`unknown owner operation ${operation}`);
}
self.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = record(data),
    id = text(message.id);
  void execute(text(message.operation), message.body).then(
    (value) => self.postMessage({ id, value }),
    (error: unknown) =>
      self.postMessage({
        id,
        failure: String(error),
        errno: Reflect.get(Object(error), "errno") ?? null,
      }),
  );
};
