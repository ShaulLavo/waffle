import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../../fs";
import { publicationObserver, type PublicationLimits } from "../../fs/publication-internal";
import { publicationCut } from "../../fs/publication";
import {
  serveResidentAuthority,
  type ResidentAuthorityServer,
} from "../../browser/publication-authority";
import { record, text } from "../../fs/publication-attachment";

const limits: PublicationLimits = {
  sessions: 16,
  operations: 16,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 8,
  logBytes: 32768,
  pins: 2,
  pinBytes: 256,
};
let backend: MemoryBackend | undefined, service: FilesystemService | undefined;
let root: FilesystemClient | undefined, server: ResidentAuthorityServer | undefined;
let handle = 0;
let ordinaryPort: MessagePort | undefined;
let holdReply: "open" | "prepare" | undefined;
let heldReply: (() => void) | undefined;
const post = BroadcastChannel.prototype.postMessage;
BroadcastChannel.prototype.postMessage = function (value: unknown): void {
  const data = record(value);
  const response = data.value;
  if (
    holdReply &&
    data.kind === "reply" &&
    response &&
    typeof response === "object" &&
    (holdReply === "open"
      ? "descriptor" in response && "token" in response
      : "key" in response && "session" in response)
  ) {
    const phase = holdReply;
    holdReply = undefined;
    heldReply = () => Reflect.apply(post, this, [value]);
    self.postMessage({ event: `${phase}Held` });
    return;
  }
  Reflect.apply(post, this, [value]);
};
async function initialize(): Promise<void> {
  backend = new MemoryBackend();
  backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
  service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  root = new FilesystemClient(connection.client);
  const dir: number = await root.asyncCall("preopen", ["/"]);
  const file: { node: number } = await root.asyncCall("resolve", [dir, "file"]);
  handle = file.node;
  root.retain(handle);
}
let guardGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let guardAttempt: Promise<void> | undefined;
let guardAbort: AbortController | undefined;
const nativeLockRequest = navigator.locks.request.bind(navigator.locks);
Object.defineProperty(navigator.locks, "request", {
  value: async (name: string, options: LockOptions, callback: LockGrantedCallback) => {
    if (guardGate && options.mode === "shared") {
      self.postMessage({ event: "guardPending" });
      await guardGate.promise;
    }
    return nativeLockRequest(name, options, callback);
  },
});
async function serviceWork(): Promise<number> {
  try {
    await root!.asyncCall("writeFile", ["/file"], new Uint8Array([99]));
    return 0;
  } catch (error) {
    return Number(Reflect.get(Object(error), "errno"));
  }
}
async function enable(workspace: string): Promise<unknown> {
  if (!root || !service) throw new Error("authority not initialized");
  const descriptor: unknown = await root.asyncCall("publicationResident", [
    root.connection.publication!.observer,
    handle,
    workspace,
  ]);
  server = await serveResidentAuthority(service.residentPublication!, new AbortController().signal);
  return descriptor;
}
function inspectBytes(output: Uint8Array): number {
  const shared = backend!.shared,
    epoch = new Int32Array(root!.connection.epoch);
  try {
    shared.beginServiceMutation(epoch);
  } catch (error) {
    return -Number(Reflect.get(Object(error), "errno"));
  }
  try {
    return shared.read(handle, [output], 0);
  } finally {
    shared.endServiceMutation(epoch);
  }
}
async function execute(operation: string, body: unknown): Promise<unknown> {
  if (operation === "beginGuard") {
    await initialize();
    await root!.asyncCall("publicationResident", [
      root!.connection.publication!.observer,
      handle,
      text(body),
    ]);
    guardGate = Promise.withResolvers<void>();
    guardAbort = new AbortController();
    guardAttempt = serveResidentAuthority(service!.residentPublication!, guardAbort.signal).then(
      (value) => {
        server = value;
      },
      () => {},
    );
    return null;
  }
  if (operation === "serviceWork") return serviceWork();
  if (operation === "failGuard") {
    guardAbort!.abort();
    guardGate!.resolve();
    await guardAttempt;
    return serviceWork();
  }
  if (operation === "idleStop") {
    const queued = serviceWork();
    await server!.stop();
    return {
      queued: await queued,
      idleStopped: await serviceWork(),
      stopped: backend!.shared.publication!.stopped,
    };
  }
  if (operation === "start") {
    await initialize();
    return enable(text(body));
  }
  if (operation === "ordinaryRoot") {
    await initialize();
    const connection = root!.fork();
    const sibling = new FilesystemClient(connection);
    const directory: number = await sibling.asyncCall("preopen", ["/"]);
    const file: { node: number } = await sibling.asyncCall("resolve", [directory, "file"]);
    sibling.retain(file.node);
    ordinaryPort = connection.port;
    return { connection, handle: file.node };
  }
  if (operation === "enable") return enable(text(body));
  if (!root || !backend || !service) throw new Error("authority not started");
  if (operation === "holdOpen" || operation === "holdPrepare") {
    holdReply = operation === "holdOpen" ? "open" : "prepare";
    return null;
  }
  if (operation === "releaseOpen" || operation === "releasePrepare") {
    heldReply?.();
    heldReply = undefined;
    return null;
  }
  if (operation === "inspect") {
    const output = new Uint8Array(8).fill(90),
      count = inspectBytes(output);
    return {
      count,
      bytes: Array.from(output),
      cut: backend.shared.publication!.cut(),
      lock: Atomics.load(backend.shared.cells, 1),
      diagnostics: backend.shared.publication!.diagnostics(),
    };
  }
  if (operation === "bypass") {
    const read = root.tryRead(handle, [new Uint8Array(3)], 0);
    const write = root.tryWrite(handle, [new Uint8Array([77])], 0);
    let namespace = 0;
    try {
      await root.asyncCall("writeFile", ["/file"], new Uint8Array([88]));
    } catch (error) {
      namespace = Number(Reflect.get(Object(error), "errno"));
    }
    return { read, write, namespace, lock: Atomics.load(backend.shared.cells, 1) };
  }
  if (operation === "changes")
    return publicationObserver(root).changes(publicationCut(body), limits.logBytes);
  if (operation === "stop") {
    root.dispose();
    await server?.stop();
    service.dispose();
    return null;
  }
  throw new Error(`unsupported fixture operation ${operation}`);
}
self.onmessage = ({ data }: MessageEvent<unknown>) => {
  const message = record(data),
    id = text(message.id);
  void execute(text(message.operation), message.body).then(
    (value) => {
      const transfer = message.operation === "ordinaryRoot" && ordinaryPort ? [ordinaryPort] : [];
      self.postMessage({ id, value }, transfer);
    },
    (error: unknown) => self.postMessage({ id, failure: String(error) }),
  );
};
