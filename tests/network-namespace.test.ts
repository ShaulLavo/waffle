import { expect, test } from "bun:test";
import { NetHelper, NetNamespace } from "../browser/net/helper.js";
import { NetHost } from "../browser/net/host.js";
import { AGAIN, ERROR, OK } from "../browser/net/protocol.js";
import { createRing } from "../browser/net/ring.js";

const bytes = (text: string) => new TextEncoder().encode(text);
function text(value: Uint8Array | number): string {
  if (typeof value === "number") throw Error(`Expected bytes, got ${value}`);
  return new TextDecoder().decode(value);
}
async function until<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 1000; n++) {
    const value = read();
    if (ready(value)) return value;
    await Bun.sleep(1);
  }
  throw Error("Network progress timed out");
}
test("namespace canonicalizes expanded IPv6 connect targets", () => {
  const namespace = new NetNamespace();
  const owner = {};
  try {
    expect(
      namespace.listen(32123, {
        owner,
        handle: 1,
        local: { address: "::1", family: "IPv6", port: 32123 },
        accept() {},
      }),
    ).toBe(32123);
    const connected = namespace.connect(32123, { data() {}, end() {} }, "0:0:0:0:0:0:0:1");
    if (typeof connected === "number") throw Error(`connect failed: ${connected}`);
    connected.socket.close();
  } finally {
    namespace.dispose();
  }
});

function fixture() {
  const namespace = new NetNamespace();
  const helpers: NetHelper[] = [];
  const hosts: NetHost[] = [];
  const add = (space = namespace) => {
    const ring = createRing();
    const helper = new NetHelper(
      ring,
      async () => {
        throw Error("External fetch");
      },
      {},
      space,
    );
    const host = new NetHost(ring, (request) => helper.handle(request), undefined, {
      shared: true,
    });
    helpers.push(helper);
    hosts.push(host);
    return { host, helper };
  };
  return {
    add,
    close() {
      for (const host of hosts) host.dispose();
      for (const helper of helpers) helper.dispose();
    },
  };
}

test("namespace routes independent rings with duplex HTTP, identity and half-close", async () => {
  const f = fixture();
  try {
    const server = f.add().host,
      client = f.add().host;
    const listener = server.listen("127.0.0.1", 32123);
    const conn = client.connect("localhost", 32123);
    expect(conn).toBeGreaterThan(0);
    const accepted = await until(
      () => server.accept(listener),
      (id) => id > 0,
    );
    expect(client.localAddr(conn)).toBe(server.peerAddr(accepted));
    expect(server.localAddr(accepted)).toBe(client.peerAddr(conn));
    const request =
      "POST /render?x=1 HTTP/1.1\r\nHost: localhost:32123\r\nContent-Length: 7\r\n\r\npayload";
    expect(client.write(conn, bytes(request))).toBe(request.length);
    expect(client.shutdown(conn)).toBe(OK);
    expect(
      text(
        await until(
          () => server.read(accepted, 1000),
          (v) => v instanceof Uint8Array,
        ),
      ),
    ).toBe(request);
    await until(
      () => server.read(accepted, 1),
      (v) => v === 0,
    );
    const response = "HTTP/1.1 201 Created\r\nContent-Length: 7\r\n\r\ncreated";
    expect(server.write(accepted, bytes(response))).toBe(response.length);
    server.shutdown(accepted);
    expect(
      text(
        await until(
          () => client.read(conn, 1000),
          (v) => v instanceof Uint8Array,
        ),
      ),
    ).toBe(response);
    await until(
      () => client.read(conn, 1),
      (v) => v === 0,
    );
  } finally {
    f.close();
  }
});

test("namespace bind conflicts, ephemeral ports and isolated runtimes", () => {
  const f = fixture();
  try {
    const a = f.add().host,
      b = f.add().host,
      isolated = f.add(new NetNamespace()).host;
    const first = a.listen("::", 0),
      second = b.listen("localhost", 0);
    expect(a.localPort(first)).not.toBe(b.localPort(second));
    expect(b.listen("localhost", a.localPort(first))).toBe(ERROR);
    expect(String(b.error(0))).toContain("EADDRINUSE");
    expect(isolated.connect("localhost", a.localPort(first))).toBe(ERROR);
    expect(String(isolated.error(0))).toContain("ECONNREFUSED");
    expect(isolated.listen("localhost", a.localPort(first))).toBeGreaterThan(0);
    expect(b.listen("localhost", 1.5)).toBe(ERROR);
  } finally {
    f.close();
  }
});

test("listener close rejects queued accepts but preserves accepted sockets and other owners", async () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add();
    const listener = a.host.listen("localhost", 32124);
    const client = b.host.connect("localhost", 32124);
    const accepted = await until(
      () => a.host.accept(listener),
      (id) => id > 0,
    );
    const queued = c.host.connect("localhost", 32124);
    a.host.close(listener);
    await until(
      () => c.host.read(queued, 1),
      (v) => v === 0,
    );
    expect(c.host.write(queued, bytes("late"))).toBe(ERROR);
    expect(a.host.write(accepted, bytes("alive"))).toBe(5);
    expect(
      text(
        await until(
          () => b.host.read(client, 20),
          (v) => v instanceof Uint8Array,
        ),
      ),
    ).toBe("alive");
    expect(b.host.connect("localhost", 32124)).toBe(ERROR);
    const foreignListener = c.host.listen("localhost", 32125);
    a.helper.dispose();
    await until(
      () => b.host.read(client, 1),
      (v) => v === 0,
    );
    expect(b.host.write(client, bytes("late"))).toBe(ERROR);
    expect(b.host.connect("localhost", 32125)).toBeGreaterThan(0);
    expect(c.host.localPort(foreignListener)).toBe(32125);
  } finally {
    f.close();
  }
});

test("namespace limits unread bytes, wakes after reads and preserves copied FIFO chunks", async () => {
  const f = fixture();
  try {
    const a = f.add().host,
      b = f.add().host;
    const listener = a.listen("localhost", 32126),
      client = b.connect("localhost", 32126);
    const accepted = await until(
      () => a.accept(listener),
      (id) => id > 0,
    );
    const chunk = new Uint8Array(65536).fill(7);
    for (let i = 0; i < 16; i++) expect(b.write(client, chunk)).toBe(chunk.length);
    chunk.fill(0);
    expect(b.write(client, bytes("blocked"))).toBe(AGAIN);
    const incoming = await until(
      () => a.read(accepted, 65536),
      (v) => v instanceof Uint8Array,
    );
    expect(incoming).toEqual(new Uint8Array(65536).fill(7));
    expect(b.write(client, bytes("tail"))).toBe(4);
    b.close(client);
    let total = 65536;
    const remaining: string[] = [];
    await until(
      () => {
        const value = a.read(accepted, 65536);
        if (!(value instanceof Uint8Array)) return value;
        total += value.length;
        remaining.push(text(value));
        return value;
      },
      (v) => v === 0,
    );
    expect(total).toBe((1 << 20) + 4);
    expect(remaining.join("")).toEndWith("tail");
  } finally {
    f.close();
  }
});

test("owner disposal removes live listeners and pending sockets without touching a different runtime", async () => {
  const f = fixture();
  try {
    const owner = f.add(),
      client = f.add(),
      isolated = f.add(new NetNamespace());
    owner.host.listen("localhost", 32127);
    const conn = client.host.connect("localhost", 32127);
    const foreign = isolated.host.listen("localhost", 32127);
    owner.helper.dispose();
    await until(
      () => client.host.read(conn, 1),
      (v) => v === 0,
    );
    expect(client.host.connect("localhost", 32127)).toBe(ERROR);
    expect(client.host.listen("localhost", 32127)).toBeGreaterThan(0);
    expect(isolated.host.localPort(foreign)).toBe(32127);
    expect(isolated.host.connect("localhost", 32127)).toBeGreaterThan(0);
    expect(owner.host.listen("localhost", 32128)).toBe(ERROR);
    owner.host.dispose();
    expect(owner.host.listen("localhost", 32128)).toBe(-3);
  } finally {
    f.close();
  }
});

test("reading a full connection wakes the blocked peer's ring and closing releases the port", async () => {
  const f = fixture();
  try {
    const server = f.add().host,
      client = f.add().host;
    const listener = server.listen("localhost", 32128),
      conn = client.connect("localhost", 32128);
    const accepted = await until(
      () => server.accept(listener),
      (id) => id > 0,
    );
    const port = client.localPort(conn);
    expect(server.listen("localhost", port)).toBe(ERROR);
    const payload = new Uint8Array(1 << 20).fill(1);
    expect(client.write(conn, payload)).toBe(payload.length);
    expect(client.write(conn, bytes("full"))).toBe(AGAIN);
    while (client.poll(0)) {}
    await until(
      () => server.read(accepted, 65536),
      (value) => value instanceof Uint8Array,
    );
    await until(
      () => client.poll(0),
      (value) => value === 1,
    );
    expect(client.write(conn, bytes("free"))).toBe(4);
    client.close(conn);
    expect(server.listen("localhost", port)).toBeGreaterThan(0);
  } finally {
    f.close();
  }
});

test("HTTP fetch crosses helpers with a body larger than the receive window", async () => {
  const f = fixture();
  try {
    const server = f.add().host,
      client = f.add().host;
    const listener = server.listen("localhost", 32129);
    const body = "a".repeat((1 << 20) + 12345).concat("tail");
    const request = client.fetch(
      JSON.stringify({ url: "http://localhost:32129/large", method: "POST" }),
      bytes(body),
    );
    const accepted = await until(
      () => server.accept(listener),
      (id) => id > 0,
    );
    let received = "";
    await until(
      () => {
        const chunk = server.read(accepted, 65536);
        if (chunk instanceof Uint8Array) received += text(chunk);
        return received;
      },
      (value) => value.endsWith(body),
    );
    expect(received).toStartWith("POST /large HTTP/1.1\r\n");
    const echoed = received.slice(received.indexOf("\r\n\r\n") + 4);
    expect(echoed).toBe(body);
    const response = `length=${echoed.length};tail=${echoed.slice(-4)}`;
    expect(
      server.write(
        accepted,
        bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${response.length}\r\n\r\n${response}`),
      ),
    ).toBeGreaterThan(0);
    await until(
      () => client.fetchHead(request),
      (value) => value instanceof Uint8Array,
    );
    expect(
      text(
        await until(
          () => client.read(request, 65536),
          (value) => value instanceof Uint8Array,
        ),
      ),
    ).toBe(response);
    await until(
      () => client.read(request, 1),
      (value) => value === 0,
    );
  } finally {
    f.close();
  }
});

test("disposing a host inside its news callback stops the watcher and releases its own listener", async () => {
  const f = fixture();
  try {
    const owner = f.add(),
      client = f.add();
    owner.host.listen("localhost", 32135);
    let calls = 0;
    owner.host.onNews(() => {
      calls++;
      owner.host.dispose();
    });
    await owner.helper.notifyFileChanged("/file.ts");
    await until(
      () => calls,
      (value) => value > 0,
    );
    const settled = calls;
    await owner.helper.notifyFileChanged("/file.ts");
    await Bun.sleep(10);
    expect(calls).toBe(settled);
    expect(owner.host.poll(-1)).toBe(0);
    expect(client.host.connect("localhost", 32135)).toBe(ERROR);
  } finally {
    f.close();
  }
});

test("disposing a cross-helper preview client reports failure and releases a blocked sender", async () => {
  const f = fixture();
  try {
    const server = f.add(),
      client = f.add();
    server.host.listen("localhost", 32148);
    let failures = 0;
    const connection = client.helper.connect(32148, {
      data() {},
      end() {},
      error() {
        failures++;
      },
    });
    expect(connection).not.toBeNull();
    connection!.write(new Uint8Array((1 << 20) + 1));
    await Bun.sleep(5);
    client.helper.dispose();
    await Bun.sleep(5);
    expect(failures).toBe(1);
    expect(client.host.listen("localhost", 32149)).toBe(ERROR);
  } finally {
    f.close();
  }
});

test("host disposal revokes a news callback already queued by a local pipe", async () => {
  const ring = createRing();
  const helper = new NetHelper(ring, async () => {
    throw Error("Unexpected fetch");
  });
  const host = new NetHost(ring, (request) => helper.handle(request));
  let calls = 0;
  try {
    host.onNews(() => {
      calls++;
    });
    host.listen("localhost", 32150);
    host.connect("localhost", 32150);
    host.dispose();
    await Bun.sleep(10);
    expect(calls).toBe(0);
  } finally {
    host.dispose();
    helper.dispose();
  }
});

test("host-side async sink receipts retain credit and wake the shared writer", async () => {
  const f = fixture();
  const receipt = Promise.withResolvers<void>();
  try {
    const server = f.add(),
      client = f.add();
    const listener = server.host.listen("localhost", 32211);
    const connection = client.helper.connect(32211, {
      data: () => receipt.promise,
      end() {},
      error() {},
    });
    expect(connection).not.toBeNull();
    const accepted = await until(
      () => server.host.accept(listener),
      (id) => id > 0,
    );
    expect(server.host.write(accepted, new Uint8Array(1 << 20))).toBe(1 << 20);
    expect(server.host.write(accepted, bytes("blocked"))).toBe(AGAIN);
    while (server.host.poll(0)) {}
    receipt.resolve();
    await until(
      () => server.host.poll(0),
      (value) => value === 1,
    );
    expect(server.host.write(accepted, bytes("resumed"))).toBe(7);
    connection!.close();
    expect(server.host.write(accepted, bytes("closed"))).toBe(ERROR);
  } finally {
    receipt.resolve();
    f.close();
  }
});
