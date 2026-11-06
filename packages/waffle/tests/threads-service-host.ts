import { PersistentBackend } from "../fs/persistent.ts";
import { FilesystemService } from "../fs/service.ts";
import { PAGE, type FilesystemConnection } from "../fs/protocol.ts";
import { fixturePayloadHooks } from "./fixtures/publication-storage.ts";
import { MetadataStore } from "./fixtures/metadata-enumeration-r173-store.ts";

export type HostCommand =
  | { kind: "start"; connection: FilesystemConnection; mode: "cold" | "growth" | "dirty" }
  | { kind: "dirty"; handle: number }
  | { kind: "release" | "stop" };
export type HostEvent =
  | { kind: "ready" | "held" | "dirty-wait" | "stopped" }
  | { kind: "error"; message: string };
let backend: PersistentBackend;
let service: FilesystemService;
class ThreadStore extends MetadataStore {
  readBarrier: (() => Promise<void>) | undefined;
  override readonly readRange = async (...args: Parameters<MetadataStore["readRange"]>) => {
    await this.readBarrier?.();
    return fixturePayloadHooks(this.payloads).readRange(...args);
  };
}
const store = new ThreadStore();
const released = Promise.withResolvers<void>();
let checkpoint: Promise<void> | undefined;
const send = (event: HostEvent) => self.postMessage(event);
async function hold() {
  send({ kind: "held" });
  await released.promise;
}

async function start({ connection, mode }: Extract<HostCommand, { kind: "start" }>) {
  const size = mode === "dirty" ? 4 : PAGE;
  await store.persist({
    generation: 1,
    root: 100,
    removes: [],
    data: new Map([["payload", new Uint8Array(size).fill(65)]]),
    upserts: [
      { ino: 100, kind: "dir", mode: 0o700, size: 0, mtime: 1, children: [["file", 101]] },
      { ino: 101, kind: "file", mode: 0o600, size, mtime: 1, data: "payload" },
    ],
  });
  backend = await PersistentBackend.open(store, {
    intervalMs: 0,
    ...(mode === "dirty" ? { dirtyLimits: { maxBytes: PAGE + 40, maxWaiters: 8 } } : {}),
  });
  if (mode === "cold") store.readBarrier = hold;
  if (mode === "growth") {
    const prepare = backend.prepare.bind(backend);
    let armed = true;
    backend.prepare = (operation, args) => {
      if (operation !== "write" || !armed) return prepare(operation, args);
      armed = false;
      return hold().then(() => prepare(operation, args));
    };
  }
  const wait = backend.waitForDirtyCapacity.bind(backend);
  backend.waitForDirtyCapacity = async (changed, cancelled) => {
    send({ kind: "dirty-wait" });
    await wait(changed, cancelled);
  };
  service = new FilesystemService(backend);
  service.connect(connection);
  send({ kind: "ready" });
}

async function command(message: HostCommand) {
  if (message.kind === "start") return start(message);
  if (message.kind === "release") return released.resolve();
  if (message.kind === "dirty") {
    const persist = store.persist.bind(store);
    store.persist = async (batch) => {
      await hold();
      await persist(batch);
    };
    checkpoint = backend.checkpoint(true, message.handle);
    void checkpoint.catch((error) =>
      send({
        kind: "error",
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      }),
    );
    return;
  }
  released.resolve();
  await checkpoint;
  await service.drainForOwner();
  service.dispose();
  await backend.close();
  backend.dispose();
  send({ kind: "stopped" });
}
self.onmessage = ({ data }: MessageEvent<HostCommand>) => {
  void command(data).catch((error) =>
    send({
      kind: "error",
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
  );
};
