import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { createNativeRelay } from "../src/node-webtransport-internal.js";

const dependencies = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
  scheduleCheck() {
    return () => {};
  },
  endpointStateChanged() {},
};

test("invalid operator material fails before the HTTP relay is constructed", () => {
  expect(() =>
    createNativeRelay(
      {
        credential: "http-credential-123",
        allowedOrigins: ["https://relay.example"],
        tcp: {
          tokenSecret: crypto.getRandomValues(new Uint8Array(32)),
          destinations: [],
          webtransport: {
            bind: { host: "0.0.0.0", port: 4433 },
            advertisedUrl: "https://relay.example:4433/v1/tcp/wt",
            certificate: { cert: "not a certificate", key: "not a key" },
          },
        },
      },
      dependencies,
    ),
  ).toThrow("certificate");
});

async function availableUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const address = socket.address();
    if (typeof address === "string") throw new Error("Expected a numeric UDP address");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => socket.close(resolve));
  }
}

test("real native loopback binds keep the derived local discovery URL", async () => {
  const port = await availableUdpPort();
  const native = createNativeRelay(
    {
      credential: "http-credential-123",
      allowedOrigins: ["https://relay.example"],
      tcp: {
        tokenSecret: crypto.getRandomValues(new Uint8Array(32)),
        destinations: [],
        webtransport: { bind: { host: "127.0.0.1", port } },
      },
    },
    dependencies,
  );
  try {
    await native.relay.tcp!.ready;
    expect(native.lifecycle().discovery()?.url).toBe(`https://127.0.0.1:${port}/v1/tcp/wt`);
  } finally {
    await native.relay.close();
  }
  expect(native.lifecycle().status().ownedEndpoints).toBe(0);
  expect(native.lifecycle().discovery()).toBeNull();
});
