import { hostFilesystemClient } from "./filesystem-host.js";
import {
  FilesystemClient,
  FilesystemCompletion,
  FilesystemService,
  MemoryBackend,
  connectFilesystemIdentity,
  createFilesystemIdentity,
  type FilesystemBackend,
  type FilesystemConnection,
  type FilesystemIdentity,
} from "../../fs/index.js";
import { SHARED_SEGMENT_BYTES } from "../../fs/shared-capacity.js";
import { DATA_PAGE_BYTES } from "../../fs/storage-geometry.js";

export { DATA_PAGE_BYTES, SHARED_SEGMENT_BYTES };
export type Cleanup = () => void | Promise<void>;

/** Keeps segment announcements away from a client that has an event loop, so it stays in the
 * state of a guest that has not returned to its loop: the pages exist, and it lacks the segment.
 * `deliver` sees each announcement instead and may attach it. */
function withoutAnnouncements<T extends { port: MessagePort }>(
  connection: T,
  deliver?: (index: number, buffer: SharedArrayBuffer) => void,
): T {
  const port = connection.port;
  let proto: object | null = Object.getPrototypeOf(port);
  let accessor: PropertyDescriptor | undefined;
  while (proto && !accessor) {
    accessor = Object.getOwnPropertyDescriptor(proto, "onmessage");
    proto = Object.getPrototypeOf(proto);
  }
  if (!accessor?.set || !accessor.get) throw new Error("message port has no onmessage accessor");
  const { get, set } = accessor;
  Object.defineProperty(port, "onmessage", {
    configurable: true,
    get: () => get.call(port),
    set(handler: ((event: MessageEvent) => void) | null) {
      const guarded =
        handler &&
        ((event: MessageEvent) => {
          if (!event.data?.segment) return handler(event);
          deliver?.(event.data.segment, event.data.buffer);
        });
      set.call(port, guarded);
    },
  });
  return connection;
}

/** True when two wrappers name the same memory. A buffer that crossed a port is a new wrapper,
 * so identity cannot tell, and comparing 16 MiB by value would print it on failure. */
export function sameBacking(
  first: SharedArrayBuffer | undefined,
  second: SharedArrayBuffer | undefined,
): boolean {
  if (!first || !second || first.byteLength !== second.byteLength) return false;
  const left = new Uint8Array(first),
    right = new Uint8Array(second);
  const at = left.length - 1;
  const previous = left[at]!;
  left[at] = previous ^ 0xff;
  const same = right[at] === (previous ^ 0xff);
  left[at] = previous;
  return same;
}

export interface Rig {
  readonly backend: MemoryBackend;
  readonly service: FilesystemService;
  readonly identity: FilesystemIdentity;
  readonly pair: ReturnType<typeof connectFilesystemIdentity>;
  /** The page-like client: it has an event loop and attaches every announced segment. */
  readonly client: FilesystemClient;
}

/** A real owner and its first client in this agent, over a tree of `segments` segments. */
export function createRig(
  segments: number,
  cleanups: Cleanup[],
  options: {
    backend?: MemoryBackend;
    publication?: Parameters<typeof createFilesystemIdentity>[2];
  } = {},
): Rig {
  const backend = options.backend ?? new MemoryBackend();
  const service = new FilesystemService(backend as FilesystemBackend);
  const identity = createFilesystemIdentity(
    undefined,
    SHARED_SEGMENT_BYTES * segments,
    options.publication,
  );
  const pair = connectFilesystemIdentity(identity);
  service.connect(pair.server);
  const client = hostFilesystemClient(service, pair);
  cleanups.push(() => {
    client.dispose();
    service.dispose();
  });
  return { backend, service, identity, pair, client };
}

/** Fills segment 0 exactly, so the next allocated page is the first page of segment 1. */
export async function fillFirstSegment(rig: Rig): Promise<void> {
  await rig.client.asyncCall("writeFile", ["/full"], new Uint8Array(SHARED_SEGMENT_BYTES));
}

export async function resolveNode(fs: FilesystemClient, name: string): Promise<number> {
  const root = await fs.asyncCall("preopen", ["/"]);
  const path = await fs.asyncCall("resolve", [root, name]);
  if (typeof path === "number" || path.node === undefined) throw new Error(`cannot find ${name}`);
  return path.node;
}

/** A forked connection that holds no extra segment and receives no announcement. */
export function unattachedConnection(rig: Rig): FilesystemConnection {
  const connection = rig.client.fork();
  connection.segments = [];
  return withoutAnnouncements(connection);
}

/** A second client in this agent that holds `name` open and lacks every extra segment. */
export async function unattachedClient(
  rig: Rig,
  name: string,
  cleanups: Cleanup[],
): Promise<{ fs: FilesystemClient; node: number }> {
  const fs = new FilesystemClient(unattachedConnection(rig));
  cleanups.push(() => fs.dispose());
  const node = await resolveNode(fs, name);
  fs.retain(node);
  return { fs, node };
}

/** A second client in this agent that holds `name` open and attaches like any yielding agent. */
export async function attachedClient(
  rig: Rig,
  name: string,
  cleanups: Cleanup[],
): Promise<{ fs: FilesystemClient; node: number }> {
  const fs = new FilesystemClient(rig.client.fork());
  cleanups.push(() => fs.dispose());
  const node = await resolveNode(fs, name);
  fs.retain(node);
  return { fs, node };
}

interface ServiceInternals {
  execute(
    session: unknown,
    id: number,
    operation: string,
    args: unknown[],
    data: Uint8Array,
  ): unknown;
}

/** Makes the owner wait before it runs the named operations. Everything else in this agent keeps
 * running, so a test can observe a caller that must not wait for the owner. */
export function holdOwner(service: FilesystemService, operations: readonly string[]) {
  const target = service as unknown as ServiceInternals;
  const execute = target.execute;
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  target.execute = async function (this: unknown, session, id, operation, args, data) {
    if (operations.includes(operation)) {
      entered.resolve();
      await gate.promise;
    }
    return Reflect.apply(execute, this, [session, id, operation, args, data]);
  };
  return {
    entered: entered.promise,
    release() {
      target.execute = execute;
      gate.resolve();
    },
  };
}

/** Runs `work` with every owner wait forbidden. The client's one blocking wait is
 * FilesystemCompletion.wait, which uses a captured Atomics.wait, so both are replaced: an
 * immediate call that tried to wait for the owner throws here. */
export function withoutWaiting<T>(work: () => T): T {
  const wait = Atomics.wait;
  const completionWait = FilesystemCompletion.prototype.wait;
  const refuse = (): never => {
    throw new Error("an immediate path waited for the owner");
  };
  Atomics.wait = refuse as typeof Atomics.wait;
  // Collecting a reply that is already there is not a wait.
  FilesystemCompletion.prototype.wait = function (this: FilesystemCompletion) {
    return this.ready ? Reflect.apply(completionWait, this, []) : refuse();
  };
  try {
    return work();
  } finally {
    Atomics.wait = wait;
    FilesystemCompletion.prototype.wait = completionWait;
  }
}

/** Waits the way poll does: by readiness, with the event loop running in between. */
export async function untilReady(
  fs: FilesystemClient,
  node: number,
  writing: boolean,
  limit = 5_000,
): Promise<void> {
  const deadline = Date.now() + limit;
  for (;;) {
    const state = fs.ioReadiness(node, writing);
    if (writing ? state.writable : state.readable) return;
    if (Date.now() > deadline) throw new Error(`never ${writing ? "writable" : "readable"}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Lets queued port messages and the owner's serial queue run. */
export async function settle(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setTimeout(resolve, 1));
}

export async function readFile(rig: Rig, path: string): Promise<Uint8Array> {
  return (await rig.client.asyncCall("readFile", [path])) as Uint8Array;
}
