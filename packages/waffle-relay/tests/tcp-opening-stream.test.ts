import { expect, test } from "bun:test";
import { ServerWebTransportStream } from "../src/tcp-webtransport-server-stream.js";
import { TcpAdmissions, tcpPolicy } from "../src/tcp-policy.js";
import { mintRelayToken } from "../src/token.js";
import { encodeOpenHeader } from "../src/tcp-protocol.js";

const target = { host: "fixture.example", port: 5432 };
async function opening(extra: "merged" | "while-resolving" | "missing-window") {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const token = await mintRelayToken(secret, { exp: Math.floor(Date.now() / 1000) + 60 });
  const events: string[] = [];
  const policy = tcpPolicy(
    { tokenSecret: secret, destinations: [target], log: (entry) => events.push(entry.event) },
    ["https://fixture.example"],
  );
  const admissions = new TcpAdmissions(policy.limits);
  let input: ReadableStreamDefaultController<Uint8Array>;
  const ready = Promise.withResolvers<void>();
  const late = Promise.withResolvers<{ address: string; family: number }[]>();
  let resolutions = 0;
  const stream = new ServerWebTransportStream(
    {
      readable: new ReadableStream({
        start(controller) {
          input = controller;
        },
      }),
      writable: new WritableStream(),
    },
    policy,
    admissions,
    admissions.reserve(),
    () => {},
    () => {},
    new Promise(() => {}),
    async () => {
      resolutions++;
      ready.resolve();
      return late.promise;
    },
  );
  try {
    const header = encodeOpenHeader({ v: 1, token, ...target, window: 16384 });
    if (extra === "missing-window") {
      const body = new TextEncoder().encode(JSON.stringify({ v: 1, token, ...target }));
      const bytes = new Uint8Array(body.length + 2);
      new DataView(bytes.buffer).setUint16(0, body.length);
      bytes.set(body, 2);
      input!.enqueue(bytes);
    } else if (extra === "merged") {
      const bytes = new Uint8Array(header.length + 6);
      bytes.set(header);
      bytes.set([0, 0, 0, 0, 1, 7], header.length);
      input!.enqueue(bytes);
    } else {
      input!.enqueue(header);
      await ready.promise;
      input!.enqueue(Uint8Array.of(0));
    }
    await stream.done;
    expect(resolutions).toBe(extra === "while-resolving" ? 1 : 0);
    expect(admissions.active).toBe(0);
    expect(events).toEqual(["close"]);
    late.resolve([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(events).toEqual(["close"]);
  } finally {
    late.resolve([]);
    stream.revoke();
    await stream.done;
  }
}
for (const extra of ["merged", "while-resolving", "missing-window"] as const)
  test(`WT opening rejects ${extra} before target publication and logs once`, () => opening(extra));
