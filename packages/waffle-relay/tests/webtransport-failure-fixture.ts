import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
const modulePath = new URL("../dist/node-webtransport-internal.js", import.meta.url).href;
const { createNativeRelay }: typeof import("../src/node-webtransport-internal.js") = await import(
  modulePath
);
import { deadline } from "../src/tcp-async.ts";

const socket = createSocket("udp4");
let relay: ReturnType<typeof createNativeRelay>["relay"] | undefined;
let second: ReturnType<typeof createNativeRelay>["relay"] | undefined;
const timeout = setTimeout(() => process.exit(1), 30000);
try {
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const options = {
    credential: "separate-native-failure-fixture",
    allowedOrigins: ["http://localhost:3000"],
    tcp: {
      tokenSecret: crypto.getRandomValues(new Uint8Array(32)),
      destinations: [],
      webtransport: { bind: { host: "127.0.0.1", port: socket.address().port } },
    },
  };
  let notifications = 0;
  const first = createNativeRelay(
    {
      ...options,
      tcp: {
        ...options.tcp,
        webtransport: {
          ...options.tcp.webtransport,
          onEndpointFailure() {
            notifications++;
            throw new Error("observer failure");
          },
        },
      },
    },
    {
      wallNow: Date.now,
      monotonicNow: () => performance.now(),
      scheduleCheck() {
        return () => {};
      },
      endpointStateChanged() {},
    },
  );
  relay = first.relay;
  await assert.rejects(deadline(relay.tcp!.ready, 12000));
  await deadline(relay.tcp!.failure!, 12000);
  await relay.close();
  assert.equal(first.lifecycle().status().ownedEndpoints, 0);
  assert.equal(notifications, 1);
  const early = createNativeRelay(options, {
    wallNow: Date.now,
    monotonicNow: () => performance.now(),
    scheduleCheck() {
      return () => {};
    },
    endpointStateChanged() {},
  });
  second = early.relay;
  const closing = second.close();
  await deadline(closing, 12000);
  assert.equal(early.lifecycle().status().ownedEndpoints, 0);
  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
      bindFailure: "rejected and cleaned",
      earlyClose: "joined",
      notifications,
    }),
  );
} finally {
  clearTimeout(timeout);
  await Promise.allSettled([relay?.close(), second?.close()]);
  await new Promise<void>((resolve) => socket.close(resolve));
}
