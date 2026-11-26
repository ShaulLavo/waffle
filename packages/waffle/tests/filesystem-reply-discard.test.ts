import { hostFilesystemClient } from "../testing/fixtures/filesystem-host.js";
import { afterEach, expect, test } from "bun:test";
import { FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs";
import { requestBytes } from "../fs/request-memory";

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

type SessionView = {
  responses: Map<number, unknown>;
  retainedRequests: Map<number, unknown>;
};

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
  await client.asyncCall("writeFile", ["/file"], new Uint8Array(200_000).fill(7));
  const root = await client.asyncCall("preopen", ["/"]);
  const handle = (await client.asyncCall("resolve", [root, "file"])).node as number;
  const sessions = Reflect.get(service, "sessions") as Set<SessionView>;
  const session = Array.from(sessions)[0]!;
  const posted: Record<string, unknown>[] = [];
  const port = pair.client.port;
  const post = port.postMessage.bind(port) as (message: unknown, transfer?: Transferable[]) => void;
  port.postMessage = ((message: Record<string, unknown>, transfer?: Transferable[]) => {
    posted.push(message);
    post(message, transfer);
  }) as typeof port.postMessage;
  return { client, root, handle, session, posted };
}

test("a plain inline reply is released without a discard, and the service keeps nothing", async () => {
  const { client, handle, session, posted } = await fixture();
  const completion = client.submit("stat", [handle]);
  expect((await completion.value()).size).toBe(200_000);
  const before = posted.length;
  completion.release();
  expect(posted.slice(before)).toEqual([]);
  expect(session.responses.has(completion.id)).toBe(false);
  expect(session.retainedRequests.has(completion.id)).toBe(false);
});

test("a resolve reply is discarded at once and frees what the service held for it", async () => {
  const { client, root, session, posted } = await fixture();
  const completion = client.submit("resolve", [root, "file"]);
  await completion.value();
  expect(session.responses.has(completion.id)).toBe(true);
  completion.release();
  expect(posted.at(-1)).toEqual({ discard: completion.id });
  await eventually(() => !session.responses.has(completion.id));
});

test("an overflowing reply of a plain operation is still discarded", async () => {
  const { client, root, session, posted } = await fixture();
  const target = "t".repeat(4096);
  const link = await client.asyncCall("resolve", [root, "link"]);
  expect(await client.asyncCall("symlink", [link, target])).toBe(0);
  const node = (await client.asyncCall("resolve", [root, "link"])).node as number;
  // A reply room smaller than the target makes the reply overflow.
  const completion = client.submit("readlink", [node], undefined, 64);
  expect(await completion.value()).toBe(target);
  completion.release();
  expect(posted.at(-1)).toEqual({ discard: completion.id });
  await eventually(
    () => !session.responses.has(completion.id) && !session.retainedRequests.has(completion.id),
  );
});

test("a request without a publication admission encodes no tagged values", async () => {
  const { client, root } = await fixture();
  const completion = client.submit("resolve", [root, "file"]);
  const input = new TextDecoder().decode(
    requestBytes(completion.buffer).slice(0, completion.cells[1]),
  );
  expect(JSON.parse(input)).toEqual({ operation: "resolve", args: [root, "file"] });
  expect((await completion.value()).node).toBeGreaterThanOrEqual(0);
  completion.release();
});
