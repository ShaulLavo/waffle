import { hostFilesystemClient } from "../testing/fixtures/filesystem-host.js";
import { afterEach, expect, test } from "bun:test";
import { FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

/** Polls an outcome, with a generous cap that only catches a hang. */
async function eventually(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition never held");
    await new Promise((done) => setTimeout(done, 1));
  }
}

async function fixture() {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = hostFilesystemClient(service, pair);
  cleanups.push(async () => {
    client.dispose();
    await service.drainForOwner();
    service.dispose();
  });
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  const root = await client.asyncCall("preopen", ["/"]);
  const sessions = Reflect.get(service, "sessions") as Set<{ responses: Map<number, unknown> }>;
  const session = Array.from(sessions)[0]!;
  const posted: Record<string, unknown>[] = [];
  const port = pair.client.port;
  const post = port.postMessage.bind(port) as (message: unknown, transfer?: Transferable[]) => void;
  port.postMessage = ((message: Record<string, unknown>, transfer?: Transferable[]) => {
    posted.push(message);
    post(message, transfer);
  }) as typeof port.postMessage;
  return { client, root, session, posted };
}

test("a consumed reply's discard rides on the next request and is still applied", async () => {
  const { client, root, session, posted } = await fixture();
  const first = client.submit("resolve", [root, "file"]);
  expect((await first.value()).node).toBeGreaterThanOrEqual(0);
  // A resolve reply stays retained until the client discards it.
  expect(session.responses.has(first.id)).toBe(true);
  const before = posted.length;
  first.release();
  const second = client.submit("resolve", [root, "file"]);
  // One message: the second request, carrying the first reply's discard.
  expect(posted.slice(before)).toEqual([
    expect.objectContaining({ id: second.id, discards: [first.id] }),
  ]);
  await second.value();
  second.release();
  await eventually(() => !session.responses.has(first.id) && !session.responses.has(second.id));
  // The last discard had no request to ride on, so a microtask sent it alone.
  expect(posted.at(-1)).toEqual({ control: true, discards: [second.id] });
});

test("malformed control fails the transport instead of being ignored", async () => {
  const { client } = await fixture();
  const connection = client.connection;
  connection.port.postMessage({ control: true, discards: ["x"] });
  await eventually(() => client.transportError()?.reason === "protocol");
});
