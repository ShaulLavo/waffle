import { testReservations } from "./fixtures/shared-memory-platform.js";
import { hostFilesystemClient } from "./fixtures/filesystem-host.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { RingWriter, createRing } from "../browser/net/ring.js";
import { Kind } from "../browser/net/protocol.js";
import { FilesystemService } from "../fs/service.js";
import { MemoryBackend } from "../fs/backend.js";
import {
  connectFilesystemIdentity,
  createFilesystemConnection,
  createFilesystemIdentity,
  reapFilesystem,
  revokeFilesystem,
  waitForFilesystemQuiescence,
} from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ProcessTable } from "../proc/table.js";
import { ExecutableRegistry } from "../proc/registry.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { DescriptorTable } from "../core/descriptors.js";
import { watchGuestModule } from "./fixtures/watch-guest.js";
import type {
  GuestWatchNotice,
  GuestWatchRuntimeRequest,
} from "./fixtures/guest-watch-runtime-worker.js";
import type { GuestWatchWriterMessage } from "./fixtures/guest-watch-writer-worker.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Ordered replies from one Worker; any failure rejects every waiter. */
function inbox<T>(failed: (value: T) => string | undefined) {
  const items: T[] = [];
  const waiters: { accept: (value: T) => boolean; resolve: (value: T) => void }[] = [];
  let failure: Error | undefined;
  const rejectors = new Set<(error: Error) => void>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const reject of rejectors) reject(failure);
  };
  return {
    fail,
    push(value: T) {
      const message = failed(value);
      if (message) return fail(Error(message));
      const index = waiters.findIndex((waiter) => waiter.accept(value));
      if (index < 0) return void items.push(value);
      waiters.splice(index, 1)[0]!.resolve(value);
    },
    take<U extends T>(accept: (value: T) => value is U): Promise<U> {
      const index = items.findIndex(accept);
      if (index >= 0) return Promise.resolve(items.splice(index, 1)[0] as U);
      return new Promise<U>((resolve, reject) => {
        if (failure) return reject(failure);
        rejectors.add(reject);
        waiters.push({
          accept,
          resolve: (value) => {
            rejectors.delete(reject);
            resolve(value as U);
          },
        });
      });
    },
  };
}

type Notice<K extends GuestWatchNotice["type"]> = Extract<GuestWatchNotice, { type: K }>;
const notice =
  <K extends GuestWatchNotice["type"]>(type: K) =>
  (value: GuestWatchNotice): value is Notice<K> =>
    value.type === type;

type WriterReply = { ready: true } | { wrote: number } | { disposed: true } | { error: string };

/**
 * A broker-launched guest waits in NetHost.poll(60000) on its armed notification set. Commits
 * from a second guest's direct writes and from the page's writeFile must wake it and reach its
 * watch drain no later than the socket byte each writer sends after its call returned.
 */
export async function guestWatchCase(
  workerUrl: string,
  helperUrl: string,
  writerUrl: string,
  { quiet = 20, iterations = 200, port = 49400 } = {},
) {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const page = hostFilesystemClient(service, pair);
  const identities = new ProcessIdentityAllocator();
  const registry = new ExecutableRegistry();
  registry.register("watcher", {
    adapter: "fixture",
    module: watchGuestModule(),
    interruptible: true,
  });
  const ring = createRing();
  const network = new RingWriter(ring);
  const guest = inbox<GuestWatchNotice>((value) =>
    value.type === "watch-failed" ? value.message : undefined,
  );
  const writer = new Worker(writerUrl, { type: "module" });
  const writes = inbox<WriterReply>((value) => ("error" in value ? value.error : undefined));
  writer.onmessage = ({ data }: MessageEvent<WriterReply>) => writes.push(data);
  writer.onerror = (event) => writes.fail(Error(event.message));
  const diagnostics: unknown[] = [];
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table: new ProcessTable(identities),
    registry,
    filesystem: {
      connect(identity) {
        const child = connectFilesystemIdentity(identity);
        service.connect(child.server);
        return child.client;
      },
      revoke: revokeFilesystem,
      reap: reapFilesystem,
      quiesce: waitForFilesystemQuiescence,
    },
    launch(context) {
      return broker.launchWorker<GuestWatchRuntimeRequest>(context, {
        workerUrl,
        notificationWorkerUrl: helperUrl,
        request: { module: context.module, args: [], env: {}, ring, port, quiet, iterations },
        onMessage: (data) => guest.push(data as GuestWatchNotice),
      });
    },
    onError: (error) => {
      diagnostics.push(error);
      guest.fail(error instanceof Error ? error : Error(String(error)));
    },
  });
  const transport = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  transport.data = { filesystem: createFilesystemIdentity(page.connection) };
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec: {
      export() {
        throw Error("unused");
      },
      import() {
        throw Error("unused");
      },
      discard() {},
    },
    postMessage: (message) => messages.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(page.connection) } }),
  });
  const writerConnection = page.fork();
  const timeout = setTimeout(() => guest.fail(Error("guest watch proof timed out")), 25000);
  const conn = 0x40000001;
  let stage = "setup";
  try {
    await page.asyncCall("mkdirp", ["/w"]);
    for (let index = 0; index < iterations; index += 2)
      await page.asyncCall("writeFile", [`/w/d${index}`, false], new Uint8Array([0]));
    const ready = writes.take((value): value is { ready: true } => "ready" in value);
    const init: GuestWatchWriterMessage = { connection: writerConnection, ring, conn };
    writer.postMessage(init, [writerConnection.port]);
    await ready;
    stage = "spawn";
    await broker.adoptRuntimeRoot(transport, { memory: [] });
    const pid = client.spawn(client.pid, {
      executable: "watcher",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [],
    });
    for (const message of messages) await broker.runtimeMessage(message, client.pid);
    await (await broker.ready()).start(pid);
    const { listener } = await guest.take(notice("watch-listening"));
    check(Atomics.load(backend.shared.watch.cells, 0) === 1, "guest subscription is not active");
    const quietWakes: number[] = [];
    for (let index = 0; index < quiet; index++) {
      stage = `quiet ${index}`;
      await page.asyncCall("writeFile", [`/w/q${index}`, false], new Uint8Array([1]));
      const seen = await guest.take(notice("watch-seen"));
      check(seen.name === `w/q${index}`, `quiet wake saw ${seen.name}`);
      quietWakes.push(seen.wakes);
    }
    await network.write(
      listener,
      Kind.Conn,
      new TextEncoder().encode(
        JSON.stringify({
          conn,
          peer: { address: "127.0.0.1", family: "IPv4", port: 40000 },
          local: { address: "127.0.0.1", family: "IPv4", port },
        }),
      ),
    );
    let pageWrites = 0;
    let directWrites = 0;
    for (let index = 0; index < iterations; index++) {
      stage = `iteration ${index}`;
      if (index % 2 === 0) {
        const wrote = writes.take((value): value is { wrote: number } => "wrote" in value);
        writer.postMessage({ write: index } satisfies GuestWatchWriterMessage);
        check((await wrote).wrote === index, "direct writer replied out of order");
        directWrites++;
      } else {
        await page.asyncCall("writeFile", [`/w/p${index}`, false], new Uint8Array([index & 0xff]));
        await network.write(conn, Kind.Data, new Uint8Array([index & 0xff]));
        pageWrites++;
      }
      const byte = await guest.take(notice("watch-byte"));
      check(byte.index === index, `guest consumed byte ${byte.index} at ${index}`);
    }
    const done = await guest.take(notice("watch-done"));
    await broker.dispose();
    service.sweep();
    const subscriptions = Atomics.load(backend.shared.watch.cells, 0);
    check(subscriptions === 0, `guest exit left ${subscriptions} subscriptions`);
    check(diagnostics.length === 0, `broker diagnostics: ${diagnostics}`);
    return { quietWakes, directWrites, pageWrites, ...done };
  } catch (error) {
    throw new Error(`guest watch proof failed at ${stage}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    const disposed = writes.take((value): value is { disposed: true } => "disposed" in value);
    writer.postMessage({ dispose: true } satisfies GuestWatchWriterMessage);
    await Promise.race([disposed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    writer.terminate();
    reapFilesystem(writerConnection);
    network.dispose();
    await broker.dispose().catch(() => {});
    descriptors.dispose();
    page.dispose();
    await service.shutdown();
  }
}
