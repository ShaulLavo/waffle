import { hostFilesystemClient } from "../testing/fixtures/filesystem-host.js";
import { afterEach, expect, test } from "bun:test";
import {
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
  revokeFilesystem,
} from "../fs";
import { SIGNAL_TRANSPORT } from "../fs/protocol";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});

function fixture(connect = true) {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  if (connect) service.connect(pair.server);
  const client = hostFilesystemClient(service, pair);
  cleanups.push(() => {
    client.dispose();
    service.dispose();
  });
  const signal = new Int32Array(pair.client.signal);
  const sessions = Reflect.get(service, "sessions") as Set<unknown>;
  return { service, pair, client, signal, sessions };
}

/** Polls an outcome, with a generous cap that only catches a hang. */
async function eventually(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition never held");
    await new Promise((done) => setTimeout(done, 1));
  }
}

test("request traffic wakes blocked waiters but never the transport watchers", async () => {
  const { client, signal } = fixture();
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([1, 2, 3]));
  const root = await client.asyncCall("preopen", ["/"]);
  for (let index = 0; index < 20; index++) {
    const path = await client.asyncCall("resolve", [root, "file"]);
    expect(client.stat(path.node).size).toBe(3);
  }
  expect(Atomics.load(signal, 0)).toBeGreaterThan(0);
  expect(Atomics.load(signal, SIGNAL_TRANSPORT)).toBe(0);
});

test("revocation wakes the transport word and the service closes the session", async () => {
  const { pair, client, signal, sessions } = fixture();
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  expect(sessions.size).toBe(1);
  revokeFilesystem(pair.client);
  expect(Atomics.load(signal, SIGNAL_TRANSPORT)).toBe(1);
  await eventually(() => sessions.size === 0);
});

test("a transport failure wakes the transport word and closes the session", async () => {
  const { pair, client, signal, sessions } = fixture();
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  pair.client.port.onmessageerror?.(new MessageEvent("messageerror"));
  expect(Atomics.load(signal, SIGNAL_TRANSPORT)).toBe(1);
  await eventually(() => sessions.size === 0);
});

test("a pending async call fails promptly when its connection is revoked", async () => {
  // No service is connected, so the request stays pending until revocation ends it.
  const { pair, client } = fixture(false);
  const pending = client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  await new Promise((done) => setTimeout(done, 1));
  revokeFilesystem(pair.client);
  await expect(pending).rejects.toMatchObject({ errno: 11 });
});

/** Wakes and counts the agents parked on one signal word. They re-check and park again. */
function parked(signal: Int32Array, word: number): number {
  return Atomics.notify(signal, word);
}
async function tick(): Promise<void> {
  await new Promise((done) => setTimeout(done, 5));
}

test("the service's transport watcher parks on the transport word, not word 0", async () => {
  const { signal, sessions } = fixture();
  await eventually(() => sessions.size === 1);
  await tick();
  expect(parked(signal, 0)).toBe(0);
  expect(parked(signal, SIGNAL_TRANSPORT)).toBe(1);
});

test("a client's revocation monitor parks on the transport word while a call is pending", async () => {
  // No service is connected, so the call stays pending and the monitor stays parked.
  const { pair, client, signal } = fixture(false);
  const pending = client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  await tick();
  expect(parked(signal, 0)).toBe(0);
  expect(parked(signal, SIGNAL_TRANSPORT)).toBe(1);
  revokeFilesystem(pair.client);
  await expect(pending).rejects.toMatchObject({ errno: 11 });
});

test("a deferred write's monitor moves to word 0, where the backend's terminal state wakes it", async () => {
  const { pair, client, signal } = fixture(false);
  const completion = client.submit("writeFile", ["/file"], new Uint8Array([1]));
  completion.onBackendSettled(() => {});
  await tick();
  expect(parked(signal, SIGNAL_TRANSPORT)).toBe(0);
  expect(parked(signal, 0)).toBe(1);
  revokeFilesystem(pair.client);
  completion.release();
});

test("a deferred write settles during shutdown even when its completion reply is lost", async () => {
  const backend = new MemoryBackend();
  const execute = backend.execute.bind(backend);
  const paused = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  backend.execute = (operation, args, data, cancelled) => {
    const result = execute(operation, args, data, cancelled);
    if (operation !== "write") return result;
    paused.resolve();
    return gate.promise.then(() => result);
  };
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = hostFilesystemClient(service, pair);
  cleanups.push(() => {
    gate.resolve();
    client.dispose();
    service.dispose();
  });
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  const root = await client.asyncCall("preopen", ["/"]);
  const handle = (await client.asyncCall("resolve", [root, "file"])).node as number;
  client.retain(handle);
  // A scalar write stays in flight across revocation until the backend commits it.
  const completion = client.submit("write", [handle, 0], new Uint8Array([2]));
  // Drop this request's { completed } reply: only the shared state can settle it now.
  const receive = pair.client.port.onmessage!;
  pair.client.port.onmessage = (event) => {
    if ((event.data as { completed?: number }).completed === completion.id) return;
    receive.call(pair.client.port, event);
  };
  let settled = false;
  completion.onBackendSettled(() => {
    settled = true;
  });
  // Like an offset lease held across the write: shutdown waits for this open section before it
  // retires the transport, so no transport wake can come until the write has settled.
  const section = Reflect.get(client, "section") as { enter(): void; exit(): void };
  section.enter();
  await paused.promise;
  const stopping = service.shutdown();
  await tick();
  expect(settled).toBe(false);
  gate.resolve();
  await eventually(() => settled);
  section.exit();
  completion.release();
  await stopping;
});
