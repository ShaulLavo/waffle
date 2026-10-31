import { residentMemory } from "./resident-memory";
import { FilesystemClient } from "../../fs/client";
import { publicationObserver } from "../../fs/publication-internal";
import { publicationCut } from "../../fs/publication";
import { record, text } from "../../fs/publication-attachment";
import {
  createPersistentResidentOwner,
  selectPersistentWorkspace,
  type PersistentResidentOwner,
} from "../../browser/persistent-resident-owner";

let owner: PersistentResidentOwner | undefined;
let observer: ReturnType<typeof publicationObserver> | undefined;
let pulse: Int32Array | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const nativeCall = FilesystemClient.prototype.asyncCall;
FilesystemClient.prototype.asyncCall = function (...args: Parameters<typeof nativeCall>) {
  if (args[0] === "publicationWorkspace" && this.connection.publication?.observer)
    observer = publicationObserver(this);
  return Reflect.apply(nativeCall, this, args);
};

async function execute(operation: string, body: unknown): Promise<unknown> {
  if (operation === "start") {
    const data = record(body);
    if (!(data.pulse instanceof SharedArrayBuffer)) throw new Error("missing test pulse");
    pulse = new Int32Array(data.pulse);
    timer = setInterval(() => Atomics.add(pulse!, 0, 1), 20);
    owner = createPersistentResidentOwner(
      {
        kind: "initial-open",
        runtimeLifetime: crypto.randomUUID(),
        attempt: crypto.randomUUID(),
        selected: selectPersistentWorkspace({ name: text(data.name), mode: "fast" }),
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
            logRecords: 8,
            logBytes: 32768,
            pins: 2,
            pinBytes: 256,
          },
        },
      },
      new AbortController().signal,
      undefined,
      residentMemory(),
    );
    return owner.ready;
  }
  if (operation === "stop") {
    await owner?.stop();
    clearInterval(timer);
    return { stopped: true };
  }
  if (operation === "probe") return { pulse: Atomics.load(pulse!, 0) };
  if (!observer) throw new Error("actual persistent factory root not observed");
  if (operation === "cut") return observer.cut();
  if (operation === "changes") return observer.changes(publicationCut(body), 32768);
  if (operation === "diagnostics") return observer.diagnostics();
  throw new Error(`unknown owner operation ${operation}`);
}
self.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = record(data),
    id = text(message.id);
  void execute(text(message.operation), message.body).then(
    (value) => self.postMessage({ id, value }),
    (error: unknown) => self.postMessage({ id, failure: String(error) }),
  );
};
