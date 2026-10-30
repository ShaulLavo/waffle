import { expect, test } from "bun:test";
import { NetHelper, NetNamespace } from "../browser/net/helper.js";
import { NetHost } from "../browser/net/host.js";
import { AGAIN, BADF, ERROR, OK, UNSUPPORTED, type NetRequest } from "../browser/net/protocol.js";
import { createRing, RingReader } from "../browser/net/ring.js";

function peer(namespace: NetNamespace) {
  const ring = createRing();
  const requests: unknown[] = [];
  const replies: number[][] = [];
  const helper = new NetHelper(
    ring,
    async () => {
      throw new TypeError("wire failure");
    },
    {},
    namespace,
  );
  const host = new NetHost(
    ring,
    (request: NetRequest) => {
      const { ...captured } = request;
      if ("reply" in captured) Reflect.deleteProperty(captured, "reply");
      requests.push(captured);
      helper.handle(request);
      if ("reply" in request) replies.push(Array.from(new Int32Array(request.reply)));
    },
    undefined,
    { shared: true },
  );
  return {
    ring,
    requests,
    replies,
    helper,
    host,
    close() {
      host.dispose();
      helper.dispose();
    },
  };
}

async function published(ring: SharedArrayBuffer, count: number) {
  const reader = new RingReader(ring);
  while (reader.generation() < count) {
    const waiting = reader.waitAsync(reader.generation());
    if (!waiting) throw new Error("This test requires the observable Atomics event bridge");
    await waiting;
  }
  const copy = new SharedArrayBuffer(ring.byteLength);
  new Uint8Array(copy).set(new Uint8Array(ring));
  return new RingReader(copy).drain();
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("literal TCP requests, reply cells, ring records, JSON and guest handles stay unchanged", async () => {
  expect([OK, ERROR, AGAIN, BADF, UNSUPPORTED]).toEqual([0, -1, -2, -3, -4]);
  const namespace = await NetNamespace.create();
  const server = peer(namespace),
    client = peer(namespace);
  try {
    expect(server.host.listen("127.0.0.1", 32158)).toBe(1);
    expect(client.host.connect("127.0.0.1", 32158)).toBe(1);
    const records = await published(server.ring, 1);
    expect(records.map(({ handle, kind, payload }) => [handle, kind, decode(payload)])).toEqual([
      [
        1,
        5,
        '{"conn":1073741824,"peer":{"address":"127.0.0.1","family":"IPv4","port":49152},"local":{"address":"127.0.0.1","family":"IPv4","port":32158}}',
      ],
    ]);
    expect(server.host.accept(1)).toBe(1073741824);
    expect(server.host.accept(1)).toBe(-2);
    expect(client.host.localPort(1)).toBe(49152);
    expect(client.host.localAddr(1)).toBe('{"address":"127.0.0.1","family":"IPv4","port":49152}');
    expect(client.host.peerAddr(1)).toBe('{"address":"127.0.0.1","family":"IPv4","port":32158}');
    expect(server.host.localAddr(1073741824)).toBe(
      '{"address":"127.0.0.1","family":"IPv4","port":32158}',
    );
    expect(server.host.peerAddr(1073741824)).toBe(
      '{"address":"127.0.0.1","family":"IPv4","port":49152}',
    );
    const data = new Uint8Array(65537).fill(17);
    expect(client.host.write(1, data)).toBe(65537);
    const incoming = await published(server.ring, 3);
    expect(incoming.map(({ handle, kind, payload }) => [handle, kind, payload.length])).toEqual([
      [1073741824, 2, 65536],
      [1073741824, 2, 1],
    ]);
    expect(incoming.every(({ payload }) => payload.every((byte) => byte === 17))).toBe(true);
    expect(server.host.read(1073741824, 65536)).toEqual(data.subarray(0, 65536));
    expect(server.host.read(1073741824, 1)).toEqual(new Uint8Array([17]));
    expect(client.host.shutdown(1)).toBe(0);
    expect(
      (await published(server.ring, 4)).map(({ handle, kind, payload }) => [
        handle,
        kind,
        payload.length,
      ]),
    ).toEqual([[1073741824, 3, 0]]);
    expect(server.host.read(1073741824, 1)).toBe(0);
    expect(client.host.close(1)).toBe(0);
    expect(client.host.close(1)).toBe(-3);
    expect(server.requests).toEqual([
      { type: "tcp-listen", id: 1, host: "127.0.0.1", port: 32158 },
      { type: "tcp-accept", id: 1073741824, listener: 1 },
      { type: "tcp-read", id: 1073741824, bytes: 65536 },
      { type: "tcp-read", id: 1073741824, bytes: 1 },
    ]);
    expect(client.requests).toEqual([
      { type: "tcp-connect", id: 1, host: "127.0.0.1", port: 32158 },
      { type: "tcp-write", id: 1, data },
      { type: "shutdown", id: 1 },
      { type: "close", id: 1 },
    ]);
    expect(server.replies).toEqual([[1, 0, 32158]]);
    expect(client.replies).toEqual([
      [1, 0, 49152],
      [1, 65537, 0],
    ]);
    expect(server.host.read(1, 1)).toBe(-3);
    expect(server.host.write(1, new Uint8Array([1]))).toBe(-4);
    expect(server.host.error(1)).toBe('{"name":"Error","message":"no error"}');
    expect(server.host.connect("127.0.0.1", 32159)).toBe(-1);
    expect(server.host.error(0)).toBe(
      '{"name":"Error","message":"loopback TCP: ECONNREFUSED","code":"ECONNREFUSED"}',
    );
    expect(server.replies.at(-1)).toEqual([1, -11, 0]);
  } finally {
    server.close();
    client.close();
    namespace.dispose();
  }
});

test("literal error ring JSON and callback wake are delivered without polling", async () => {
  const namespace = await NetNamespace.create();
  const p = peer(namespace);
  try {
    const id = p.host.fetch('{"url":"https://example.invalid"}');
    expect(id).toBe(1);
    const records = await published(p.ring, 1);
    expect(records.map(({ handle, kind, payload }) => [handle, kind, decode(payload)])).toEqual([
      [1, 4, '{"name":"TypeError","message":"wire failure"}'],
    ]);
    expect(p.host.read(id, 1)).toBe(-1);
    expect(p.host.error(id)).toBe('{"name":"TypeError","message":"wire failure"}');
    const wake = Promise.withResolvers<void>();
    p.host.onNews(wake.resolve);
    p.helper.handle({ type: "listen", id: 2, host: "127.0.0.1", port: 32160 });
    const connection = p.helper.connect(32160, { data() {}, end() {}, error() {} });
    expect(connection).not.toBeNull();
    await wake.promise;
    connection?.close();
  } finally {
    p.close();
    namespace.dispose();
  }
});

test("literal writable ring event releases credit and revocation drops queued publication", async () => {
  const namespace = await NetNamespace.create();
  const server = peer(namespace),
    client = peer(namespace);
  try {
    server.host.listen("127.0.0.1", 32161);
    client.host.connect("127.0.0.1", 32161);
    await published(server.ring, 1);
    const accepted = server.host.accept(1);
    for (let n = 0; n < 16; n++) {
      expect(client.host.write(1, new Uint8Array(65536))).toBe(65536);
      await published(server.ring, n + 2);
      server.host.poll(0);
    }
    expect(client.host.write(1, new Uint8Array([1]))).toBe(-2);
    expect(server.host.read(accepted, 2)).toEqual(new Uint8Array(2));
    expect(
      (await published(client.ring, 1)).map(({ handle, kind, payload }) => [
        handle,
        kind,
        payload.length,
      ]),
    ).toEqual([[1, 10, 0]]);
    expect(client.host.write(1, new Uint8Array([1]))).toBe(1);
    const generation = new RingReader(server.ring).generation();
    server.helper.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(new RingReader(server.ring).generation()).toBe(generation);
    expect(client.host.write(1, new Uint8Array([2]))).toBe(-1);
  } finally {
    server.close();
    client.close();
    namespace.dispose();
  }
});
