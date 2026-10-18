import { expect, test } from "bun:test";
import { NetHelper, type NetFetch } from "../browser/net/helper";
import { NetHost } from "../browser/net/host";
import {
  AGAIN,
  BADF,
  ERROR,
  Kind,
  type NetRequest,
  OK,
  UNSUPPORTED,
} from "../browser/net/protocol";
import { createRing, type RingRecord, RingReader, RingWriter } from "../browser/net/ring";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | number) => {
  if (typeof value === "number") throw new Error(`Expected bytes, got ${value}`);
  return new TextDecoder().decode(value);
};
async function until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("Network service did not make progress");
}

test("generic network helper uses only its injected fetch and streams its result", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const transport: NetFetch = async (url, options) => {
    calls.push({ url, options });
    return new Response("injected response", { status: 201, headers: { "x-transport": "test" } });
  };
  const sab = createRing();
  const helper = new NetHelper(sab, transport);
  const host = new NetHost(sab, (request) => helper.handle(request));
  try {
    const handle = host.fetch(
      JSON.stringify({
        url: "https://network.invalid/api",
        method: "post",
        headers: [["x-request", "test"]],
        redirect: "manual",
      }),
      encode("payload"),
    );
    expect(handle).toBeGreaterThan(0);
    await until(() => typeof host.fetchHead(handle) !== "number");
    const head = JSON.parse(decode(host.fetchHead(handle)));
    expect(head.status).toBe(201);
    expect(head.headers).toContainEqual(["x-transport", "test"]);
    let incoming: Uint8Array | number = AGAIN;
    await until(() => {
      incoming = host.read(handle, 65536);
      return incoming instanceof Uint8Array;
    });
    expect(decode(incoming)).toBe("injected response");
    await until(() => host.read(handle, 65536) === 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://network.invalid/api");
    expect(calls[0]!.options.method).toBe("POST");
    expect(calls[0]!.options.headers).toEqual([["x-request", "test"]]);
    expect(calls[0]!.options.redirect).toBe("manual");
    expect(calls[0]!.options.body).toEqual(encode("payload"));
    expect(calls[0]!.options.signal).toBeInstanceOf(AbortSignal);
  } finally {
    helper.dispose();
  }
});

test("injected fetch is called as a function rather than a method of the helper", async () => {
  let receiver: unknown = "not called";
  const helper = new NetHelper(createRing(), async function (this: unknown) {
    // oxlint-disable-next-line typescript/no-this-alias -- This test records the actual callback/Worker receiver.
    receiver = this;
    return new Response(null);
  });
  try {
    helper.handle({
      type: "fetch",
      id: 1,
      method: "GET",
      url: "https://network.invalid/",
      headers: [],
      body: null,
      redirect: "follow",
    });
    await until(() => receiver !== "not called");
    expect(receiver).toBeUndefined();
  } finally {
    helper.dispose();
  }
});

test("generic helper disposal aborts the injected fetch without publishing an expected abort error", async () => {
  let signal: AbortSignal | undefined;
  let finished = false;
  const sab = createRing();
  const helper = new NetHelper(sab, async (_url, options) => {
    signal = options.signal!;
    try {
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
      throw new Error("Unreachable");
    } finally {
      finished = true;
    }
  });
  const host = new NetHost(sab, (request) => helper.handle(request));
  try {
    host.fetch(JSON.stringify({ url: "https://network.invalid/" }), null);
    expect(signal?.aborted).toBe(false);
    helper.dispose();
    await until(() => finished);
    expect(signal?.aborted).toBe(true);
    expect(host.poll(0)).toBe(0);
  } finally {
    helper.dispose();
  }
});

test("generic host owns outgoing bytes without detaching its caller's buffers", () => {
  const messages: NetRequest[] = [];
  const host = new NetHost(createRing(), (request, transfer) => {
    messages.push(structuredClone(request, { transfer }));
  });
  const body = encode("owned by caller");
  const handle = host.fetch(
    JSON.stringify({ url: "https://network.invalid/", method: "POST" }),
    body,
  );
  expect(handle).toBeGreaterThan(0);
  expect(decode(body)).toBe("owned by caller");
  expect(messages[0]).toMatchObject({ type: "fetch", body: encode("owned by caller") });
});

test("generic handles support local pipes, partial reads, half-close and per-host isolation", () => {
  const host = new NetHost(createRing(), () => {});
  const other = new NetHost(createRing(), () => {});
  const listener = host.listen("127.0.0.1", 0);
  const port = host.localPort(listener);
  expect(other.connect("127.0.0.1", port)).toBe(ERROR);
  expect(JSON.parse(String(other.error(0))).code).toBe("ECONNREFUSED");
  expect(host.accept(listener)).toBe(AGAIN);
  const client = host.connect("localhost", port);
  const server = host.accept(listener);
  expect(server).toBeGreaterThan(0);
  expect(host.write(client, encode("request"))).toBe(7);
  expect(host.shutdown(client)).toBe(OK);
  expect(decode(host.read(server, 3))).toBe("req");
  expect(decode(host.read(server, 20))).toBe("uest");
  expect(host.read(server, 20)).toBe(0);
  expect(host.write(server, encode("response"))).toBe(8);
  expect(decode(host.read(client, 20))).toBe("response");
  expect(host.write(client, encode("late"))).toBe(ERROR);
  expect(JSON.parse(String(host.peerAddr(client))).port).toBe(port);
  expect(JSON.parse(String(host.localAddr(server))).port).toBe(port);
  expect(host.close(client)).toBe(OK);
  expect(host.close(server)).toBe(OK);
  expect(host.close(listener)).toBe(OK);
  expect(host.read(client, 20)).toBe(BADF);
});

test("generic fetch reaches a local listener without calling the injected transport", async () => {
  let fetches = 0;
  const sab = createRing();
  const helper = new NetHelper(sab, async () => {
    fetches++;
    throw new Error("Unexpected external fetch");
  });
  const host = new NetHost(sab, (request) => helper.handle(request));
  try {
    const listener = host.listen("localhost", 3000);
    const request = host.fetch(
      JSON.stringify({ url: "http://localhost:3000/api?x=1", method: "POST" }),
      encode("body"),
    );
    let connection = AGAIN;
    await until(() => {
      connection = host.accept(listener);
      return connection > 0;
    });
    let incoming: Uint8Array | number = AGAIN;
    await until(() => {
      incoming = host.read(connection, 65536);
      return incoming instanceof Uint8Array;
    });
    expect(decode(incoming)).toContain("POST /api?x=1 HTTP/1.1");
    expect(decode(incoming)).toEndWith("body");
    expect(
      host.write(connection, encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")),
    ).toBeGreaterThan(0);
    await until(() => typeof host.fetchHead(request) !== "number");
    await until(() => {
      incoming = host.read(request, 65536);
      return incoming instanceof Uint8Array;
    });
    expect(decode(incoming)).toBe("ok");
    expect(fetches).toBe(0);
  } finally {
    helper.dispose();
  }
});

test("generic host returns protocol errors and acknowledges only consumed fetch bytes", async () => {
  const sab = createRing();
  const sent: NetRequest[] = [];
  const host = new NetHost(sab, (request) => sent.push(request));
  expect(host.fetch("not json", null)).toBe(ERROR);
  expect(host.fetch(JSON.stringify({ url: "not a URL" }), null)).toBe(ERROR);
  expect(host.connect("network.invalid", 80)).toBe(UNSUPPORTED);
  expect(host.read(99, 10)).toBe(BADF);
  const handle = host.fetch(JSON.stringify({ url: "https://network.invalid/" }), null);
  const writer = new RingWriter(sab);
  try {
    expect(host.fetchHead(handle)).toBe(AGAIN);
    await writer.write(handle, Kind.Head, encode('{"status":200}'));
    await writer.write(handle, Kind.Data, encode("body"));
    await writer.write(handle, Kind.End);
    expect(decode(host.fetchHead(handle))).toBe('{"status":200}');
    expect(decode(host.read(handle, 2))).toBe("bo");
    expect(sent.at(-1)).toEqual({ type: "ack", id: handle, bytes: 2 });
    expect(decode(host.read(handle, 20))).toBe("dy");
    expect(sent.at(-1)).toEqual({ type: "ack", id: handle, bytes: 2 });
    expect(host.read(handle, 20)).toBe(0);
    expect(host.close(handle)).toBe(OK);
  } finally {
    writer.dispose();
  }
});

test("generic filesystem notices wake the host without replaying contents", async () => {
  const updates: { path: string; bytes: Uint8Array }[] = [];
  const sab = createRing();
  const helper = new NetHelper(sab, async () => {
    throw new Error("Unexpected fetch");
  });
  const host = new NetHost(
    sab,
    () => {},
    (path, bytes) => updates.push({ path, bytes }),
  );
  try {
    await helper.notifyFileChanged("/app.ts");
    expect(host.poll(0)).toBe(1);
    expect(updates).toEqual([]);
    await helper.changeFile("/app.ts", "replacement");
    expect(host.poll(0)).toBe(1);
    expect(updates).toEqual([{ path: "/app.ts", bytes: encode("replacement") }]);
  } finally {
    helper.dispose();
  }
});

for (const ending of ["end", "error"] as const) {
  test(`loopback response writes keep every chunk in FIFO order with ${ending} last`, async () => {
    const sab = createRing();
    const reader = new RingReader(sab);
    const helper = new NetHelper(sab, async () => {
      throw new Error("Unexpected external fetch");
    });
    let records: RingRecord[] = [];
    try {
      helper.handle({ type: "listen", id: 1, host: "localhost", port: 3000 });
      helper.handle({
        type: "fetch",
        id: 2,
        method: "GET",
        url: "http://localhost:3000/",
        headers: [],
        body: null,
        redirect: "follow",
      });
      await until(() => {
        records = records.concat(reader.drain());
        return records.some((record) => record.kind === Kind.Conn);
      });
      const connection = JSON.parse(
        decode(records.find((record) => record.kind === Kind.Conn)!.payload),
      ).conn;
      const body = "A".repeat(130000).concat("BBB");
      const length = ending === "end" ? body.length : body.length + 1;
      const first = encode(
        `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\n\r\n${"A".repeat(130000)}`,
      );
      const second = encode("BBB");
      helper.handle({ type: "write", id: connection, data: first });
      helper.handle({ type: "write", id: connection, data: second });
      first.fill(0);
      second.fill(0);
      if (ending === "error") helper.handle({ type: "close", id: connection });
      const terminal = ending === "end" ? Kind.End : Kind.Error;
      await until(() => {
        records = records.concat(reader.drain());
        const response = records.filter((record) => record.handle === 2);
        return (
          response.some((record) => record.kind === terminal) &&
          response.reduce(
            (size, record) => size + (record.kind === Kind.Data ? record.payload.length : 0),
            0,
          ) === body.length
        );
      });
      const response = records.filter((record) => record.handle === 2);
      expect(response.map((record) => record.kind)).toEqual([
        Kind.Head,
        Kind.Data,
        Kind.Data,
        Kind.Data,
        terminal,
      ]);
      expect(
        response
          .filter((record) => record.kind === Kind.Data)
          .map((record) => decode(record.payload))
          .join(""),
      ).toBe(body);
      expect(response.at(-1)!.kind).toBe(terminal);
    } finally {
      helper.dispose();
      reader.drain();
    }
  });
}

test("closing a listener terminalizes pending local peers without helper close requests", () => {
  const requests: NetRequest[] = [];
  const host = new NetHost(createRing(), (request) => requests.push(request));
  const listener = host.listen("localhost", 3000);
  const client = host.connect("localhost", 3000);
  expect(client).toBeGreaterThan(0);
  expect(host.poll(0)).toBe(1);
  expect(host.poll(0)).toBe(0);
  try {
    expect(host.close(listener)).toBe(OK);
    expect(host.read(client, 1)).toBe(0);
    expect(host.poll(0)).toBe(1);
    expect(host.write(client, encode("too late"))).toBe(ERROR);
    expect(JSON.parse(String(host.error(client))).code).toBe("EPIPE");
    expect(requests.filter((request) => request.type === "close")).toEqual([
      { type: "close", id: listener },
    ]);
  } finally {
    host.close(client);
    host.close(listener);
  }
});

test("closing a listener still refuses unaccepted helper-owned connections", async () => {
  const sab = createRing();
  const requests: NetRequest[] = [];
  const host = new NetHost(sab, (request) => requests.push(request));
  const writer = new RingWriter(sab);
  const listener = host.listen("localhost", 3000);
  const remote = 0x40000001;
  try {
    await writer.write(
      listener,
      Kind.Conn,
      encode(
        JSON.stringify({
          conn: remote,
          peer: { address: "127.0.0.1", family: "IPv4", port: 40000 },
        }),
      ),
    );
    host.poll(0);
    expect(host.close(listener)).toBe(OK);
    expect(requests.filter((request) => request.type === "close")).toEqual([
      { type: "close", id: remote },
      { type: "close", id: listener },
    ]);
  } finally {
    host.close(listener);
    writer.dispose();
  }
});

for (const delivered of [false, true]) {
  test(`closing a loopback fetch releases its preview connection ${delivered ? "after" : "before"} request delivery`, async () => {
    const sab = createRing();
    const reader = new RingReader(sab);
    const helper = new NetHelper(sab, async () => {
      throw new Error("Unexpected external fetch");
    });
    let records: RingRecord[] = [];
    try {
      helper.handle({ type: "listen", id: 1, host: "localhost", port: 3000 });
      helper.handle({
        type: "fetch",
        id: 2,
        method: "GET",
        url: "http://localhost:3000/stream",
        headers: [],
        body: null,
        redirect: "follow",
      });
      if (delivered)
        await until(() => {
          records = records.concat(reader.drain());
          return records.some((record) => record.kind === Kind.Data);
        });
      expect(Reflect.get(helper, "connections").size).toBe(1);
      helper.handle({ type: "close", id: 2 });
      expect(Reflect.get(helper, "connections").size).toBe(0);
      await until(() => {
        records = records.concat(reader.drain());
        return records.some((record) => record.kind === Kind.End);
      });
      const announcement = records.find((record) => record.kind === Kind.Conn)!;
      const connection = JSON.parse(decode(announcement.payload)).conn;
      expect(
        records.filter((record) => record.handle === connection).map((record) => record.kind),
      ).toEqual([Kind.Data, Kind.End]);
      expect(records.filter((record) => record.handle === 2)).toEqual([]);
      expect(Reflect.get(helper, "fetches").size).toBe(0);
    } finally {
      helper.dispose();
      reader.drain();
    }
  });
}

test("generic network services contain no Bun engine, cache or guest-memory bindings", async () => {
  for (const name of ["helper", "host"]) {
    const source = await Bun.file(new URL(`../browser/net/${name}.ts`, import.meta.url)).text();
    expect(source).not.toMatch(
      /(?:web\/src|install-cache|installFetch|engineNet|hostFetch|SLOT_NAMES|SlotImpls|MemoryViews|WebAssembly\.Memory|metaPtr|bodyPtr)/,
    );
  }
});
