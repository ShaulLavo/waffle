import { expect, test } from "bun:test";
import { NetHelper, NetNamespace, type NetLookup } from "../browser/net/helper.js";
import { NetHost } from "../browser/net/host.js";
import { AGAIN, BADF, ERROR, MAX_RECORD, OK } from "../browser/net/protocol.js";
import { CAPACITY, createRing, RingReader } from "../browser/net/ring.js";
import type { RuntimeNetworkLookupResult } from "../index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const record: RuntimeNetworkLookupResult = { address: "2001:db8::662", family: 6 };
const records = [record];

function fixture(lookup: NetLookup, namespace: NetNamespace) {
  const ring = createRing();
  const helper = new NetHelper(
    ring,
    async () => {
      throw Error("Lookup consumer must not fetch");
    },
    {},
    namespace,
    undefined,
    lookup,
  );
  const host = new NetHost(ring, (request) => helper.handle(request), undefined, { shared: true });
  return {
    host,
    ring,
    reader: new RingReader(ring),
    close() {
      try {
        host.dispose();
      } finally {
        helper.dispose();
      }
    },
  };
}

async function ready(host: NetHost, handle: number): Promise<Uint8Array | number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = host.lookupHead(handle);
    if (result !== AGAIN) return result;
    await Bun.sleep(1);
  }
  throw Error("Lookup consumer did not receive a terminal head");
}

function bytes(value: Uint8Array | number): Uint8Array {
  if (typeof value === "number") throw Error(`Expected lookup bytes, received ${value}`);
  return value;
}

test("lookup size query survives ring reuse before bounded byte copies", async () => {
  const bulk = Array.from({ length: 40_000 }, () => record);
  const bulkBytes = encoder.encode(JSON.stringify(bulk));
  expect(bulkBytes.byteLength).toBeGreaterThan(CAPACITY);
  const namespace = await NetNamespace.create();
  const f = fixture((hostname) => (hostname === "bulk.example" ? bulk : records), namespace);
  try {
    const handle = f.host.lookupStart("sized.example");
    const queried = bytes(await ready(f.host, handle));
    const size = queried.byteLength;
    const expected = encoder.encode(JSON.stringify(records));
    expect(size).toBe(expected.byteLength);
    expect(queried.buffer).not.toBe(f.ring);
    const generation = f.reader.generation();

    const other = f.host.lookupStart("bulk.example");
    expect(bytes(await ready(f.host, other))).toEqual(bulkBytes);
    expect(f.reader.generation() - generation).toBeGreaterThan(CAPACITY / MAX_RECORD);
    expect(f.host.close(other)).toBe(OK);

    // Exercise the byte API without installing Bun's pointer/size ABI slots.
    const destination = new Uint8Array(size + 10).fill(0xa5);
    destination.set(bytes(f.host.lookupHead(handle)), 5);
    expect(destination.subarray(0, 5)).toEqual(new Uint8Array(5).fill(0xa5));
    expect(destination.subarray(5, 5 + size)).toEqual(expected);
    expect(destination.subarray(5 + size)).toEqual(new Uint8Array(5).fill(0xa5));
    destination.fill(0);
    expect(queried).toEqual(expected);
    expect(bytes(f.host.lookupHead(handle))).toEqual(expected);
    expect(f.host.close(handle)).toBe(OK);
    expect(f.host.lookupHead(handle)).toBe(BADF);
  } finally {
    f.close();
    namespace.dispose();
  }
});

test("fragmented lookup failure preserves UTF-8 identity and request option snapshots", async () => {
  const hostname = "münchen.例え.🧭.invalid";
  const identity = {
    name: "LookupError",
    message: "🧭".repeat(MAX_RECORD),
    code: "EAI_例え",
    syscall: "getaddrinfo",
    hostname,
  };
  const encoded = encoder.encode(JSON.stringify(identity));
  expect(encoded.byteLength).toBeGreaterThan(MAX_RECORD);
  expect((encoded[MAX_RECORD] ?? 0) & 0xc0).toBe(0x80);
  const seen: unknown[] = [];
  let familyReads = 0;
  let hintsReads = 0;
  let family: 4 | 6 = 6;
  let hints = 42;
  const namespace = await NetNamespace.create();
  const f = fixture((receivedHostname, options) => {
    seen.push([receivedHostname, options]);
    throw Object.assign(new Error(identity.message), identity);
  }, namespace);
  try {
    const handle = f.host.lookupStart(hostname, {
      get family() {
        familyReads++;
        return family;
      },
      get hints() {
        hintsReads++;
        return hints;
      },
    });
    family = 4;
    hints = 0;
    expect(f.host.lookupHead(handle)).toBe(AGAIN);
    expect(await ready(f.host, handle)).toBe(ERROR);
    expect(seen).toEqual([[hostname, { family: 6, hints: 42 }]]);
    expect([familyReads, hintsReads]).toEqual([1, 1]);
    const error = f.host.error(handle);
    if (typeof error === "number") throw Error(`Expected error identity, received ${error}`);
    expect(encoder.encode(error)).toEqual(encoded);
    expect(JSON.parse(error)).toEqual(identity);
    expect(f.reader.generation()).toBeGreaterThan(1);
    expect(f.host.lookupHead(handle)).toBe(ERROR);
    expect(f.host.error(handle)).toBe(error);
    expect(f.host.close(handle)).toBe(OK);
    expect(f.host.error(handle)).toBe(BADF);
  } finally {
    f.close();
    namespace.dispose();
  }
});

test("closing another kind and cancelling a queued head preserve sibling ring generations", async () => {
  const pending = Promise.withResolvers<RuntimeNetworkLookupResult[]>();
  const namespace = await NetNamespace.create();
  const first = fixture(
    (hostname) => (hostname === "late.example" ? pending.promise : records),
    namespace,
  );
  const sibling = fixture(() => records, namespace);
  try {
    const cancelled = first.host.lookupStart("late.example");
    const siblingHandle = sibling.host.lookupStart("sibling.example");
    expect(cancelled).toBe(siblingHandle);
    const queued = first.host.lookupStart("queued.example");
    const listener = first.host.listen("::", 0);
    expect(first.host.lookupHead(listener)).toBe(BADF);
    expect(first.host.close(listener)).toBe(OK);
    await Bun.sleep(0);
    expect(first.reader.generation()).toBe(1);
    expect(sibling.reader.generation()).toBe(1);
    const firstGeneration = first.reader.generation();
    const siblingGeneration = sibling.reader.generation();

    // Cancel a published head before a host call drains it, and a provider still awaiting completion.
    expect(first.host.close(queued)).toBe(OK);
    expect(first.host.close(cancelled)).toBe(OK);
    pending.resolve(records);
    await Bun.sleep(0);
    expect(first.reader.generation()).toBe(firstGeneration);
    expect(sibling.reader.generation()).toBe(siblingGeneration);
    expect(first.host.poll(0)).toBe(1);
    expect(first.host.poll(0)).toBe(0);
    expect(first.host.lookupHead(queued)).toBe(BADF);
    expect(first.host.lookupHead(cancelled)).toBe(BADF);
    expect(decoder.decode(bytes(sibling.host.lookupHead(siblingHandle)))).toBe(
      JSON.stringify(records),
    );
    expect(sibling.host.poll(0)).toBe(1);
    expect(sibling.host.poll(0)).toBe(0);

    const next = first.host.lookupStart("healthy.example");
    expect(next).toBeGreaterThan(queued);
    expect(bytes(await ready(first.host, next))).toEqual(encoder.encode(JSON.stringify(records)));
    expect(first.host.lookupHead(cancelled)).toBe(BADF);
  } finally {
    first.close();
    sibling.close();
    namespace.dispose();
  }
});
