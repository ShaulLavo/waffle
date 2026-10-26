import { expect, test } from "bun:test";
import { NetHelper, NetNamespace } from "../browser/net/helper.js";
import { NetHost } from "../browser/net/host.js";
import { AGAIN, CONN_BASE, ERROR, UNSUPPORTED } from "../browser/net/protocol.js";
import { createRing } from "../browser/net/ring.js";

function fixture(shared: boolean) {
  const namespace = new NetNamespace();
  const helpers: NetHelper[] = [];
  const hosts: NetHost[] = [];
  let externalFetches = 0;
  const add = () => {
    const ring = createRing();
    const helper = new NetHelper(
      ring,
      async () => {
        externalFetches++;
        throw Error("External fetch forbidden");
      },
      {},
      namespace,
    );
    const host = new NetHost(ring, helper.handle.bind(helper), undefined, { shared });
    helpers.push(helper);
    hosts.push(host);
    return { host, helper };
  };
  return {
    add,
    externalFetches: () => externalFetches,
    close() {
      for (const host of hosts) host.dispose();
      for (const helper of helpers) helper.dispose();
    },
  };
}

const invalidPorts = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["1.5", 1.5],
  ["-1", -1],
  ["65536", 65536],
] as const;

const bindings = [
  ["::", "::1", "IPv6", "::1", "IPv6"],
  ["::1", "::1", "IPv6", "::1", "IPv6"],
  ["0:0:0:0:0:0:0:1", "::1", "IPv6", "::1", "IPv6"],
  ["::1", "0:0:0:0:0:0:0:1", "IPv6", "::1", "IPv6"],
  ["::", "127.0.0.1", "IPv6", "::ffff:127.0.0.1", "IPv4"],
  ["0.0.0.0", "127.0.0.1", "IPv4", "127.0.0.1", "IPv4"],
  ["127.0.0.1", "localhost", "IPv4", "127.0.0.1", "IPv4"],
  ["localhost", "127.0.0.1", "IPv4", "127.0.0.1", "IPv4"],
] as const;

for (const shared of [false, true]) {
  test.each(bindings)(
    `endpoint metadata shared=${shared} bind=%s connect=%s`,
    async (bind, target, family, acceptedAddress, clientFamily) => {
      const f = fixture(shared);
      try {
        const server = f.add().host;
        const client = shared ? f.add().host : server;
        const listener = server.listen(bind, 0);
        const port = server.localPort(listener);
        const address =
          bind === "localhost" ? "127.0.0.1" : bind === "0:0:0:0:0:0:0:1" ? "::1" : bind;
        expect(JSON.parse(String(server.localAddr(listener)))).toEqual({ address, family, port });
        const conn = client.connect(target, port);
        expect(conn).toBeGreaterThan(0);
        await Promise.resolve();
        const accepted = server.accept(listener);
        expect(accepted).toBeGreaterThan(0);
        const clientPort = client.localPort(conn);
        const clientAddress = clientFamily === "IPv6" ? "::1" : "127.0.0.1";
        expect(JSON.parse(String(client.localAddr(conn)))).toEqual({
          address: clientAddress,
          family: clientFamily,
          port: clientPort,
        });
        expect(JSON.parse(String(client.peerAddr(conn)))).toEqual({
          address: clientAddress,
          family: clientFamily,
          port,
        });
        expect(JSON.parse(String(server.localAddr(accepted)))).toEqual({
          address: acceptedAddress,
          family,
          port,
        });
        expect(JSON.parse(String(server.peerAddr(accepted)))).toEqual({
          address: acceptedAddress,
          family,
          port: clientPort,
        });
        server.close(listener);
        expect(JSON.parse(String(server.localAddr(accepted)))).toEqual({
          address: acceptedAddress,
          family,
          port,
        });
      } finally {
        f.close();
      }
    },
  );

  test(`unsupported binds and family mismatch do not allocate shared=${shared}`, () => {
    const f = fixture(shared);
    try {
      const server = f.add().host;
      const client = shared ? f.add().host : server;
      expect(server.listen("192.0.2.1", 32155)).toBe(UNSUPPORTED);
      expect(String(server.error(0))).toContain("ENOTSUP");
      expect(server.listen("example.invalid", 32155)).toBe(UNSUPPORTED);
      const listener = server.listen("::1", 32155);
      expect(listener).toBeGreaterThan(0);
      expect(client.connect("127.0.0.1", 32155)).toBe(ERROR);
      expect(String(client.error(0))).toContain("ECONNREFUSED");
      server.close(listener);
      expect(server.listen("127.0.0.1", 32155)).toBeGreaterThan(0);
      expect(client.connect("::1", 32155)).toBe(ERROR);
      expect(String(client.error(0))).toContain("ECONNREFUSED");
      expect(client.connect("192.0.2.1", 32155)).toBe(UNSUPPORTED);
    } finally {
      f.close();
    }
  });

  test.each(invalidPorts)(
    `listen rejects invalid port %s without retention shared=${shared}`,
    (_name, port) => {
      const f = fixture(shared);
      try {
        const host = f.add().host;
        expect(host.listen("127.0.0.1", port)).toBe(ERROR);
        expect(host.connect("127.0.0.1", port)).toBe(ERROR);
      } finally {
        f.close();
      }
    },
  );

  test(`preview peers use the virtual listener family shared=${shared}`, async () => {
    const f = fixture(shared);
    try {
      const { host, helper } = f.add();
      const listener = host.listen("::", 32156);
      const preview = helper.connect(32156, { data() {}, end() {}, error() {} });
      expect(preview).not.toBeNull();
      await Promise.resolve();
      const accepted = host.accept(listener);
      expect(JSON.parse(String(host.localAddr(accepted)))).toEqual({
        address: "::1",
        family: "IPv6",
        port: 32156,
      });
      expect(JSON.parse(String(host.peerAddr(accepted)))).toMatchObject({
        address: "::1",
        family: "IPv6",
      });
      preview?.close();
    } finally {
      f.close();
    }
  });
}

async function settleFetch(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function fetchURL(host: NetHost, hostname: string, port: number): number {
  return host.fetch(JSON.stringify({ url: `http://${hostname}:${port}/family?check=1` }));
}

const refusedFetches = [
  ["::1", "127.0.0.1", "[::1]"],
  ["::1", "localhost", "[::1]"],
  ["::1", "0.0.0.0", "[::1]"],
  ["127.0.0.1", "[::1]", "127.0.0.1"],
  ["0.0.0.0", "[::]", "127.0.0.1"],
] as const;

const acceptedFetches = [
  ["::", "127.0.0.1", "::ffff:127.0.0.1", "IPv6"],
  ["::", "localhost", "::ffff:127.0.0.1", "IPv6"],
  ["::", "0.0.0.0", "::ffff:127.0.0.1", "IPv6"],
  ["::", "[::1]", "::1", "IPv6"],
  ["::1", "[0:0:0:0:0:0:0:1]", "::1", "IPv6"],
  ["0.0.0.0", "127.0.0.1", "127.0.0.1", "IPv4"],
] as const;

for (const shared of [false, true]) {
  test.each(refusedFetches)(
    `virtual HTTP refuses incompatible destinations without allocation shared=${shared} bind=%s fetch=%s`,
    async (bind, destination, valid) => {
      const f = fixture(shared);
      try {
        const server = f.add().host;
        const client = shared ? f.add().host : server;
        const listener = server.listen(bind, 32158);
        const fetched = fetchURL(client, destination, 32158);
        await settleFetch();
        expect(server.accept(listener)).toBe(AGAIN);
        expect(client.fetchHead(fetched)).toBe(ERROR);
        expect(String(client.error(fetched))).toContain("ECONNREFUSED");
        expect(client.read(fetched, 1024)).toBe(ERROR);
        client.close(fetched);
        const next = fetchURL(client, valid, 32158);
        await settleFetch();
        const accepted = server.accept(listener);
        expect(accepted).toBe(CONN_BASE);
        const peer = JSON.parse(String(server.peerAddr(accepted)));
        expect(peer.port).toBe(shared ? 49152 : 40000 + (CONN_BASE % 20000));
        expect(server.accept(listener)).toBe(AGAIN);
        expect(f.externalFetches()).toBe(0);
        client.close(next);
      } finally {
        f.close();
      }
    },
  );

  test.each(acceptedFetches)(
    `virtual HTTP retains destination endpoints and completes shared=${shared} bind=%s fetch=%s`,
    async (bind, destination, address, family) => {
      const f = fixture(shared);
      try {
        const server = f.add().host;
        const client = shared ? f.add().host : server;
        const listener = server.listen(bind, 32159);
        const fetched = fetchURL(client, destination, 32159);
        await settleFetch();
        const accepted = server.accept(listener);
        expect(accepted).toBeGreaterThan(0);
        expect(JSON.parse(String(server.localAddr(accepted)))).toEqual({
          address,
          family,
          port: 32159,
        });
        expect(JSON.parse(String(server.peerAddr(accepted)))).toEqual({
          address,
          family,
          port: shared ? 49152 : 40000 + (CONN_BASE % 20000),
        });
        const request = server.read(accepted, 65536);
        expect(request).toBeInstanceOf(Uint8Array);
        expect(
          new TextDecoder().decode(request instanceof Uint8Array ? request : undefined),
        ).toStartWith("GET /family?check=1 HTTP/1.1\r\n");
        const response = new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        expect(server.write(accepted, response)).toBe(response.length);
        server.shutdown(accepted);
        await settleFetch();
        const head = client.fetchHead(fetched);
        expect(head).toBeInstanceOf(Uint8Array);
        expect(
          JSON.parse(new TextDecoder().decode(head instanceof Uint8Array ? head : undefined))
            .status,
        ).toBe(200);
        const body = client.read(fetched, 1024);
        expect(new TextDecoder().decode(body instanceof Uint8Array ? body : undefined)).toBe("ok");
        expect(client.read(fetched, 1024)).toBe(0);
        expect(f.externalFetches()).toBe(0);
        client.close(fetched);
      } finally {
        f.close();
      }
    },
  );
}
