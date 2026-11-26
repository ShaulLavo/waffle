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
