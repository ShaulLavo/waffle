import { expect, test } from "bun:test";
import { snapshotWebTransportAddress } from "../src/webtransport-address.js";

test("loopback defaults use canonical discovery URL", () => {
  expect(
    snapshotWebTransportAddress({ bind: { host: "127.42.0.9", port: 4433 } }),
  ).toEqual({
    bind: { host: "127.42.0.9", port: 4433 },
    advertisedUrl: "https://127.42.0.9:4433/v1/tcp/wt",
    advertisedHostname: "127.42.0.9",
  });
  expect(snapshotWebTransportAddress({ bind: { host: "0:0:0:0:0:0:0:1", port: 4433 } })).toEqual({
    bind: { host: "::1", port: 4433 },
    advertisedUrl: "https://[::1]:4433/v1/tcp/wt",
    advertisedHostname: "::1",
  });
});

test("public authority keeps serialized URL and canonical identity separate", () => {
  expect(
    snapshotWebTransportAddress({
      bind: { host: "127.0.0.1", port: 4433 },
      advertisedUrl: "https://[2001:db8::1]/v1/tcp/wt",
    }),
  ).toEqual({
    bind: { host: "127.0.0.1", port: 4433 },
    advertisedUrl: "https://[2001:db8::1]/v1/tcp/wt",
    advertisedHostname: "2001:db8::1",
  });
  expect(
    snapshotWebTransportAddress({
      bind: { host: "0.0.0.0", port: 4433 },
      advertisedUrl: "https://relay.example:443/v1/tcp/wt",
    }).advertisedUrl,
  ).toBe("https://relay.example/v1/tcp/wt");
});

test("bind and advertised validation rejects unsafe or legacy shapes", () => {
  const invalid = [
    { bind: { host: "0.0.0.0", port: 4433 } },
    { bind: { host: "192.0.2.10", port: 4433 } },
    { bind: { host: "fe80::1%eth0", port: 4433 } },
    { bind: { host: "::ffff:192.0.2.1", port: 4433 } },
    { bind: { host: "127.0.0.1", port: 0 }, advertisedUrl: "https://relay.example/v1/tcp/wt" },
    { bind: { host: "127.0.0.1", port: 4433 }, advertisedUrl: "https://[::]/v1/tcp/wt" },
    {
      bind: { host: "127.0.0.1", port: 4433 },
      advertisedUrl: "https://relay.example/v1/tcp/wt?",
    },
    { bind: { host: "127.0.0.1", port: 4433 }, advertisedUrl: "https://relay.example/wrong" },
  ];
  for (const options of invalid) expect(() => snapshotWebTransportAddress(options)).toThrow();
  const credentials = new URL("https://relay.example/v1/tcp/wt");
  credentials.username = "u";
  credentials.password = "p";
  expect(() =>
    snapshotWebTransportAddress({ bind: { host: "127.0.0.1", port: 4433 }, advertisedUrl: credentials }),
  ).toThrow();
  expect(() =>
    snapshotWebTransportAddress({
      host: "127.0.0.1",
      port: 4433,
    } as never),
  ).toThrow();
});

test("URL and bind inputs are copied synchronously", () => {
  const url = new URL("https://relay.example:443/v1/tcp/wt");
  const bind = { host: "127.0.0.1", port: 4433 };
  const snapshot = snapshotWebTransportAddress({ bind, advertisedUrl: url });
  url.hostname = "mutated.example";
  bind.host = "0.0.0.0";
  bind.port = 1;
  expect(snapshot).toEqual({
    bind: { host: "127.0.0.1", port: 4433 },
    advertisedUrl: "https://relay.example/v1/tcp/wt",
    advertisedHostname: "relay.example",
  });
});
