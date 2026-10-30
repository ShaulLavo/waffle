import { expect, test } from "bun:test";
import { NetHelper, NetNamespace, type NetLookup } from "../browser/net/helper.js";
import { NetHost } from "../browser/net/host.js";
import { AGAIN, BADF, ERROR, OK, UNSUPPORTED, type NetRequest } from "../browser/net/protocol.js";
import { createRing, RingReader, RingWriter } from "../browser/net/ring.js";
import {
  createRuntime,
  type RuntimeNetwork,
  type RuntimeNetworkLookupOptions,
  type RuntimeNetworkLookupResult,
} from "../index.js";
import type { LookupWorkerMessage } from "./network-lookup-worker.js";

const noFetch = async () => {
  throw Error("Lookup must not use external fetch");
};
const records: RuntimeNetworkLookupResult[] = [{ address: "127.0.0.1", family: 4 }];
async function fixture(lookup?: NetLookup, shared = false, assertLive = () => {}) {
  const ring = createRing();
  const namespace = await NetNamespace.create();
  const helper = new NetHelper(ring, noFetch, {}, namespace, assertLive, lookup);
  const host = new NetHost(ring, (request) => helper.handle(request), undefined, { shared });
  return {
    host,
    helper,
    ring,
    close() {
      try {
        host.dispose();
      } finally {
        helper.dispose();
        namespace.dispose();
      }
    },
  };
}
async function settle() {
  await Bun.sleep(0);
}
async function head(host: NetHost, handle: number) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = host.lookupHead(handle);
    if (value !== AGAIN) return value;
    await Bun.sleep(1);
  }
  throw Error("Lookup head never became ready");
}
function decode(value: Uint8Array | number): unknown {
  if (typeof value === "number") throw Error(`Expected lookup bytes, got ${value}`);
  return JSON.parse(new TextDecoder().decode(value));
}
function runtime() {
  return createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
    processHost() {
      throw Error("Lookup activated processes");
    },
  });
}

async function expectPolicy(
  network: RuntimeNetwork,
  host: NetHost,
  hostname: string,
  options: RuntimeNetworkLookupOptions,
) {
  const id = host.lookupStart(hostname, options);
  let expected: RuntimeNetworkLookupResult[];
  try {
    expected = network.lookup(hostname, options);
  } catch (error) {
    expect(await head(host, id)).toBe(ERROR);
    if (!(error instanceof Error)) throw error;
    const received = JSON.parse(String(host.error(id)));
    expect(received).toMatchObject({ name: error.name, message: error.message });
    expect(received).toMatchObject(error);
    return;
  }
  expect(decode(await head(host, id))).toEqual(expected);
}

for (const shared of [false, true]) {
  test(`lookup heads share allocation, remain repeatable and reject other handle operations shared=${shared}`, async () => {
    const f = await fixture(undefined, shared);
    try {
      const lookup = f.host.lookupStart("localhost");
      expect(lookup).toBe(1);
      expect(f.host.lookupHead(lookup)).toBe(AGAIN);
      const fetch = f.host.fetch(JSON.stringify({ url: "https://network.invalid/" }));
      const listener = f.host.listen("::", 0);
      expect(fetch).toBe(2);
      expect(listener).toBe(3);
      expect(f.host.lookupHead(fetch)).toBe(BADF);
      expect(f.host.lookupHead(listener)).toBe(BADF);
      expect(f.host.lookupHead(999)).toBe(BADF);
      expect(f.host.fetchHead(lookup)).toBe(BADF);
      expect(f.host.read(lookup, 1)).toBe(BADF);
      expect(f.host.write(lookup, new Uint8Array([1]))).toBe(UNSUPPORTED);
      expect(f.host.shutdown(lookup)).toBe(BADF);
      expect(f.host.accept(lookup)).toBe(BADF);
      expect(f.host.localPort(lookup)).toBe(BADF);
      expect(f.host.localAddr(lookup)).toBe(BADF);
      expect(f.host.peerAddr(lookup)).toBe(BADF);
      const bytes = await head(f.host, lookup);
      expect(decode(bytes)).toEqual(records);
      expect(f.host.lookupHead(lookup)).toBe(bytes);
      expect(f.host.close(lookup)).toBe(OK);
      expect(f.host.lookupHead(lookup)).toBe(BADF);
      expect(f.host.error(lookup)).toBe(BADF);
      expect(f.host.close(lookup)).toBe(BADF);
      expect(f.host.localPort(listener)).toBeGreaterThan(0);
    } finally {
      f.close();
    }
  });
}

test("runtime-created helpers delegate every option and error to the existing lookup policy", async () => {
  const owner = runtime();
  const hosts: NetHost[] = [];
  const cases: [string, RuntimeNetworkLookupOptions][] = [
    ["localhost", {}],
    ["127.0.0.1", { family: 4, hints: 0 }],
    ["::1", { family: 6 }],
    ["localhost", { family: 6 }],
    ["::1", { family: 4 }],
    ["LOCALHOST", {}],
    ["localhost", { hints: 1 }],
    ["example.com", {}],
    ["", {}],
  ];
  try {
    const network = await owner.network();
    for (const [hostname, options] of cases) {
      const ring = createRing();
      const helper = network.createHelper({ ring, fetch: noFetch });
      const host = new NetHost(ring, helper.handle);
      hosts.push(host);
      await expectPolicy(network, host, hostname, options);
    }
  } finally {
    for (const host of hosts) host.dispose();
    await owner.dispose();
  }
});

test("lookup helpers within one runtime retain separate same-numbered handles and cancellation", async () => {
  const owner = runtime();
  const hosts: NetHost[] = [];
  try {
    const network = await owner.network();
    const rings = [createRing(), createRing()];
    for (const ring of rings) {
      const helper = network.createHelper({ ring, fetch: noFetch });
      hosts.push(new NetHost(ring, helper.handle));
    }
    const first = hosts[0]!;
    const second = hosts[1]!;
    expect(first.lookupStart("localhost")).toBe(1);
    expect(second.lookupStart("::1", { family: 6 })).toBe(1);
    first.close(1);
    expect(decode(await head(second, 1))).toEqual(network.lookup("::1", { family: 6 }));
    expect(new RingReader(rings[0]!).drain()).toEqual([]);
    expect(first.lookupHead(1)).toBe(BADF);
    const invalid = Reflect.apply(second.lookupStart, second, ["localhost", { family: 5 }]);
    expect(await head(second, invalid)).toBe(ERROR);
    expect(JSON.parse(String(second.error(invalid))).name).toBe("TypeError");
  } finally {
    for (const host of hosts) host.dispose();
    await owner.dispose();
  }
});

test("lookup helper snapshots request options before its final disposal admission check", async () => {
  let calls = 0;
  const f = await fixture(() => {
    calls++;
    return records;
  });
  try {
    f.helper.handle({
      type: "lookup",
      id: 1,
      hostname: "localhost",
      options: {
        get family(): 4 {
          f.helper.dispose();
          return 4;
        },
      },
    });
    await settle();
    expect(calls).toBe(0);
    expect(new RingReader(f.ring).drain()).toEqual([]);
  } finally {
    f.close();
  }
});

test("helper preserves delayed resolver order/options and all lookup error fields", async () => {
  const pending = Promise.withResolvers<RuntimeNetworkLookupResult[]>();
  const seen: unknown[] = [];
  const f = await fixture(function (this: void, hostname, options) {
    expect(this).toBeUndefined();
    seen.push([hostname, options]);
    return pending.promise;
  });
  try {
    const options = { family: 6 as const, hints: 42 };
    const id = f.host.lookupStart("resolver.example", options);
    options.hints = 0;
    expect(f.host.lookupHead(id)).toBe(AGAIN);
    await settle();
    expect(seen).toEqual([["resolver.example", { family: 6, hints: 42 }]]);
    const result: RuntimeNetworkLookupResult[] = [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ];
    pending.resolve(result);
    expect(decode(await head(f.host, id))).toEqual(result);
  } finally {
    f.close();
  }
  const failure = Object.assign(new TypeError("resolver denied"), {
    code: "EAI_TEST",
    syscall: "getaddrinfo",
    hostname: "resolver.example",
  });
  const failed = await fixture(() => Promise.reject(failure));
  try {
    const id = failed.host.lookupStart("resolver.example");
    expect(await head(failed.host, id)).toBe(ERROR);
    expect(JSON.parse(String(failed.host.error(id)))).toEqual({
      name: "TypeError",
      message: failure.message,
      code: failure.code,
      syscall: failure.syscall,
      hostname: failure.hostname,
    });
  } finally {
    failed.close();
  }
});

for (const action of ["close", "host-dispose", "helper-dispose", "owner-revoke"] as const) {
  test(`lookup ${action} suppresses both late success and failure without touching a sibling`, async () => {
    for (const reject of [false, true]) {
      const pending = Promise.withResolvers<RuntimeNetworkLookupResult[]>();
      let live = true;
      let starts = 0;
      const f = await fixture(
        () => {
          starts++;
          return pending.promise;
        },
        false,
        () => {
          if (!live) throw Error("Runtime is disposed");
        },
      );
      const sibling = await fixture();
      try {
        const id = f.host.lookupStart("delayed.example");
        await settle();
        expect(starts).toBe(1);
        const before = Atomics.load(new Int32Array(f.ring), 0);
        if (action === "close") f.host.close(id);
        if (action === "host-dispose") f.host.dispose();
        if (action === "helper-dispose") f.helper.dispose();
        if (action === "owner-revoke") live = false;
        if (reject) pending.reject(Error("late failure"));
        else pending.resolve(records);
        await settle();
        await settle();
        if (action !== "host-dispose") expect(Atomics.load(new Int32Array(f.ring), 0)).toBe(before);
        expect(sibling.host.lookupStart("localhost")).toBe(1);
        expect(decode(await head(sibling.host, 1))).toEqual(records);
        live = true;
        f.host.dispose();
        expect(f.host.lookupHead(id)).toBe(BADF);
        expect(f.host.lookupStart("localhost")).toBe(BADF);
      } finally {
        live = true;
        f.close();
        sibling.close();
      }
    }
  });
}

test.each(["localhost", "unsupported.example"])(
  "closing the default provider before completion suppresses publication: %s",
  async (hostname) => {
    const f = await fixture();
    try {
      const id = f.host.lookupStart(hostname);
      f.host.close(id);
      await settle();
      expect(new RingReader(f.ring).drain()).toEqual([]);
      expect(f.host.lookupHead(id)).toBe(BADF);
    } finally {
      f.close();
    }
  },
);

test("lookup admission snapshots accessors before liveness and rolls back transport failures", async () => {
  const f = await fixture();
  try {
    expect(
      f.host.lookupStart("localhost", {
        get family(): 4 {
          f.host.dispose();
          return 4;
        },
      }),
    ).toBe(BADF);
    expect(f.host.lookupHead(1)).toBe(BADF);
  } finally {
    f.close();
  }
  const failure = Error("send failed");
  const host = new NetHost(createRing(), () => {
    throw failure;
  });
  expect(() => host.lookupStart("localhost")).toThrow(failure);
  expect(host.lookupHead(1)).toBe(BADF);
  host.dispose();
});

test("lookup fragments preserve long provider results and full default-policy error identity", async () => {
  const result: RuntimeNetworkLookupResult[] = Array.from({ length: 4000 }, () => ({
    address: "::1",
    family: 6,
  }));
  const f = await fixture(() => result);
  try {
    expect(decode(await head(f.host, f.host.lookupStart("resolver.example")))).toEqual(result);
  } finally {
    f.close();
  }
  const failed = await fixture();
  const hostname = "unsupported-".repeat(10000);
  try {
    const id = failed.host.lookupStart(hostname);
    expect(await head(failed.host, id)).toBe(ERROR);
    expect(JSON.parse(String(failed.host.error(id)))).toMatchObject({
      name: "RuntimeNetworkLookupError",
      code: "ENOTSUP",
      hostname,
      syscall: "getaddrinfo",
    });
    expect(decode(await head(failed.host, failed.host.lookupStart("localhost")))).toEqual(records);
  } finally {
    failed.close();
  }
});

test("lookup head ignores records for other handle kinds and drops late records after close", async () => {
  const f = await fixture(() => new Promise(() => {}));
  const writer = new RingWriter(f.ring);
  try {
    const id = f.host.lookupStart("pending.example");
    await writer.write(id, 1, new TextEncoder().encode("wrong fetch head"));
    expect(f.host.lookupHead(id)).toBe(AGAIN);
    f.host.close(id);
    await writer.write(id, 11, new TextEncoder().encode(JSON.stringify(records)));
    expect(f.host.lookupHead(id)).toBe(BADF);
  } finally {
    writer.dispose();
    f.close();
  }
});

async function blockedLookup(
  helper: Pick<NetHelper, "handle">,
  ring: SharedArrayBuffer,
  hostname: string,
  options: RuntimeNetworkLookupOptions = {},
  followup?: string,
) {
  const worker = new Worker(new URL("./network-lookup-worker.ts", import.meta.url), {
    type: "module",
  });
  const result = Promise.withResolvers<Extract<LookupWorkerMessage, { kind: "result" }>>();
  const timeout = setTimeout(
    () => result.reject(Error("Lookup worker did not reach a terminal head")),
    2000,
  );
  let stopped = false;
  let request: NetRequest | undefined;
  worker.onmessage = ({ data }: MessageEvent<LookupWorkerMessage>) => {
    if (stopped) return;
    if (data.kind === "failure") {
      result.reject(Error(data.message));
      return;
    }
    if (data.kind === "result") {
      result.resolve(data);
      return;
    }
    if (data.kind === "net") {
      if (data.request.type === "lookup") request = data.request;
      else helper.handle(data.request);
      return;
    }
    worker.postMessage({ kind: "event" });
    if (!request) {
      result.reject(Error("Worker did not send lookup before blocking"));
      return;
    }
    helper.handle(request);
    request = undefined;
  };
  worker.onerror = (event) => result.reject(Error(event.message));
  try {
    worker.postMessage({ kind: "run", ring, hostname, options, followup });
    return await result.promise;
  } finally {
    clearTimeout(timeout);
    stopped = true;
    worker.terminate();
  }
}

for (const [hostname, options] of [
  ["localhost", { family: 4 }],
  ["::1", { family: 6 }],
  ["example.com", {}],
] satisfies [string, RuntimeNetworkLookupOptions][]) {
  test(`actual Worker resolves ${hostname} through the ring while blocked in poll`, async () => {
    const owner = runtime();
    try {
      const network = await owner.network();
      const ring = createRing();
      const helper = network.createHelper({ ring, fetch: noFetch });
      const completed = await blockedLookup(helper, ring, hostname, options);
      expect(completed.messageEvents).toBe(0);
      expect(completed.polls).toBeGreaterThan(0);
      expect(completed.closed).toBe(BADF);
      if (hostname === "example.com") {
        expect(completed.head).toBe(ERROR);
        expect(JSON.parse(String(completed.error))).toMatchObject({
          name: "RuntimeNetworkLookupError",
          code: "ENOTSUP",
          hostname,
          syscall: "getaddrinfo",
        });
      } else expect(JSON.parse(String(completed.head))).toEqual(network.lookup(hostname, options));
    } finally {
      await owner.dispose();
    }
  });
}

const malformedModes = [
  "undefined head",
  "null-prototype rejection",
  "throwing name getter",
  "throwing message getter",
  "throwing code getter",
  "throwing syscall getter",
  "throwing hostname getter",
  "throwing string conversion",
  "throwing property inspection",
] as const;
type MalformedMode = (typeof malformedModes)[number];
function malformedProvider(mode: MalformedMode): NetLookup {
  return (hostname) => {
    if (hostname === "localhost") return records;
    if (mode === "undefined head") return Object.assign([], { toJSON: () => undefined });
    if (mode === "null-prototype rejection") throw Object.create(null);
    if (mode === "throwing string conversion") {
      throw {
        [Symbol.toPrimitive]() {
          throw Error("unprintable");
        },
      };
    }
    if (mode === "throwing property inspection") {
      throw new Proxy(
        {},
        {
          has() {
            throw Error("uninspectable");
          },
        },
      );
    }
    const field = mode.split(" ")[1]!;
    throw Object.defineProperty(new Error("malformed lookup failure"), field, {
      get() {
        throw Error("unreadable");
      },
    });
  };
}

for (const mode of malformedModes) {
  test(`blocked-poll malformed provider terminates with ERROR: ${mode}`, async () => {
    const unhandled: unknown[] = [];
    const rejected = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", rejected);
    const f = await fixture(malformedProvider(mode));
    try {
      const completed = await blockedLookup(f.helper, f.ring, "malformed.example", {}, "localhost");
      expect(completed.head).toBe(ERROR);
      expect(completed.polls).toBeGreaterThan(0);
      expect(completed.messageEvents).toBe(0);
      expect(completed.closed).toBe(BADF);
      expect(JSON.parse(String(completed.error))).toEqual(
        mode === "undefined head"
          ? { name: "TypeError", message: "Lookup result is not JSON serializable" }
          : { name: "Error", message: "Lookup failed" },
      );
      expect(completed.followup?.head).toBe(JSON.stringify(records));
      expect(completed.followup?.closed).toBe(BADF);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", rejected);
      f.close();
    }
  });
}
