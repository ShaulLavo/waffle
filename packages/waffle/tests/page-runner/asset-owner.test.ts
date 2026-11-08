import { expect, test } from "bun:test";
import { Collector, type DocumentState } from "./collector.js";
import { HostConsumers } from "./owned-consumers.js";
import { serveCollector } from "./suite-host.js";
import type { AssetHoldCallback } from "./protocol.js";

const path = "/programs/shell-engine.wasm";
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 255, 0]);
function setup() {
  const collector = new Collector("run", ["A", "B"], ["A", "B"], { listIds: () => ["A", "B"], check() {} });
  const consumers = new HostConsumers();
  const hosted = serveCollector(
    collector,
    {
      [path]: new Blob([bytes], { type: "application/wasm" }),
      "/programs/test-guest.wasm": new Blob([bytes]),
      "/page.js": "export {};",
      "/ordinary.js": "original string",
    },
    undefined,
    0,
    undefined,
    consumers,
  );
  const requests: Promise<Response>[] = [];
  const releases: (() => void)[] = [];
  async function document(id = "A") {
    const token = crypto.randomUUID();
    const state = collector.expect(
      { id, role: "case", execution: "host", caseIds: [id] },
      token,
      `${hosted.origin}/?token=${token}`,
      "root",
    );
    hosted.configurations.set(token, { run: collector.run, token });
    await (await fetch(state.expectedURL)).text();
    state.doc = `doc-${id}`;
    state.host = { kind: "ready" };
    collector.beginHost(state, id);
    hosted.assetOwner.bind(state, () => {});
    return state;
  }
  function get(state?: DocumentState, suffix = "", init: RequestInit = {}) {
    const response = fetch(`${hosted.origin}${path}${suffix}`, {
      ...init,
      headers: state ? { Referer: state.expectedURL, ...init.headers } : init.headers,
    });
    requests.push(response);
    void response.catch(() => {});
    return response;
  }
  function gate() {
    const deferred = Promise.withResolvers<void>();
    releases.push(deferred.resolve);
    return deferred;
  }
  async function close() {
    for (const release of releases) release();
    await hosted.server.stop(true);
    await Promise.allSettled(requests);
    expect(await consumers.join(1000)).toBe(true);
  }
  return { ...hosted, collector, consumers, document, get, gate, close };
}
type Fixture = ReturnType<typeof setup>;
async function control(run: (fixture: Fixture) => Promise<void>) {
  const fixture = setup();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}
function hold(f: Fixture, state: DocumentState, callback: AssetHoldCallback) {
  f.assetOwner.hold(state, path, callback);
}

test("held ordinary bytes, MIME, status and all headers match the unheld response", () =>
  control(async (f) => {
    const original = await f.get();
    const expectedHeaders = Array.from(original.headers);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
    const state = await f.document();
    const release = f.gate(),
      entered = f.gate();
    let calls = 0;
    hold(f, state, async (request) => {
      calls++;
      entered.resolve();
      await release.promise;
      await request.continue();
    });
    let received = false;
    const response = f.get(state).then((value) => {
      received = true;
      return value;
    });
    await entered.promise;
    expect(received).toBe(false);
    release.resolve();
    const actual = await response;
    expect(actual.status).toBe(original.status);
    expect(Array.from(actual.headers)).toEqual(expectedHeaders);
    expect(new Uint8Array(await actual.arrayBuffer())).toEqual(bytes);
    expect(calls).toBe(1);
    expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
  }));

test("continue hands off independently of callback completion and remains valid after revocation", () =>
  control(async (f) => {
    const state = await f.document();
    const entered = f.gate(),
      release = f.gate(),
      after = f.gate();
    hold(f, state, async (request) => {
      entered.resolve();
      await release.promise;
      await request.continue();
      await after.promise;
    });
    const response = f.get(state);
    await entered.promise;
    f.assetOwner.revoke(state);
    release.resolve();
    expect(new Uint8Array(await (await response).arrayBuffer())).toEqual(bytes);
    expect(await f.assetOwner.join(state, performance.now() + 20)).toBe(false);
    expect(f.assetOwner.pending(state)).toBe(true);
    after.resolve();
    expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
  }));

test("each repeated GET has its own once-only continuation", () =>
  control(async (f) => {
    const state = await f.document();
    let calls = 0;
    hold(f, state, async (request) => {
      calls++;
      await request.continue();
    });
    const responses = await Promise.all([f.get(state), f.get(state)]);
    for (const response of responses)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(calls).toBe(2);
  }));

test("duplicate HTML before protection fails registration, HEAD does not count", () =>
  control(async (f) => {
    const state = await f.document();
    expect((await fetch(state.expectedURL, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(state.expectedURL)).status).toBe(200);
    expect(() =>
      hold(f, state, async (request) => {
        await request.continue();
      }),
    ).toThrow("exactly one");
  }));

test("protected HTML GET and HEAD fail closed and revoke new admissions", () =>
  control(async (f) => {
    const state = await f.document();
    hold(f, state, async (request) => {
      await request.continue();
    });
    const response = await fetch(state.expectedURL);
    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain("__suiteConfiguration=");
    expect((await fetch(state.expectedURL, { method: "HEAD" })).status).toBe(410);
    expect((await f.get(state)).status).toBe(410);
  }));

test("protected asset HEAD is ordinary and no-hold current cases keep original responses", () =>
  control(async (f) => {
    const a = await f.document();
    hold(f, a, async (request) => {
      await request.continue();
    });
    expect((await f.get(undefined, "", { method: "HEAD" })).status).toBe(200);
    f.assetOwner.revoke(a);
    const b = await f.document("B");
    expect(new Uint8Array(await (await f.get(b)).arrayBuffer())).toEqual(bytes);
    expect((await f.get(a)).status).toBe(410);
  }));

for (const referer of [undefined, "http://wrong/", "origin", "missing-token"]) {
  test(`protected path rejects ${referer ?? "missing"} referrer without guessing active case`, () =>
    control(async (f) => {
      const state = await f.document();
      let calls = 0;
      hold(f, state, async (request) => {
        calls++;
        await request.continue();
      });
      const value =
        referer === "origin"
          ? `${f.origin}/`
          : referer === "missing-token"
            ? `${f.origin}/?token=unknown`
            : referer;
      expect(
        (await f.get(undefined, "", { headers: value ? { Referer: value } : {} })).status,
      ).toBe(410);
      expect(calls).toBe(0);
    }));
}

test("query and stale physical, document and host states cannot admit protected requests", () =>
  control(async (f) => {
    const state = await f.document();
    let calls = 0;
    hold(f, state, async (request) => {
      calls++;
      await request.continue();
    });
    expect((await f.get(state, "?changed=1")).status).toBe(410);
    state.retiring = true;
    expect((await f.get(state)).status).toBe(410);
    state.retiring = false;
    state.doc = "changed";
    expect((await f.get(state)).status).toBe(410);
    expect(calls).toBe(0);
  }));

for (const failure of [undefined, null, false, 0, "", new Error("exact callback failure")]) {
  test(`synchronous callback failure preserves identity ${String(failure)}`, () =>
    control(async (f) => {
      const state = await f.document();
      hold(f, state, () => {
        throw failure;
      });
      expect((await f.get(state)).status).toBe(409);
      expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
      expect(f.assetOwner.errors(state)[0]).toBe(failure);
    }));
}

test("callback return without continue rejects handoff, after-continue failure cannot retract bytes", () =>
  control(async (f) => {
    const a = await f.document();
    hold(f, a, async () => {});
    expect((await f.get(a)).status).toBe(409);
    expect(String(f.assetOwner.errors(a)[0])).toContain("without continue");
    f.assetOwner.revoke(a);
    const b = await f.document("B");
    const failure = new Error("after handoff");
    hold(f, b, async (request) => {
      await request.continue();
      throw failure;
    });
    expect(new Uint8Array(await (await f.get(b)).arrayBuffer())).toEqual(bytes);
    expect(await f.assetOwner.join(b, performance.now() + 500)).toBe(true);
    expect(f.assetOwner.errors(b)[0]).toBe(failure);
  }));

test("double continue fails even when dropped, without a second response", () =>
  control(async (f) => {
    const state = await f.document();
    hold(f, state, async (request) => {
      void request.continue();
      void request.continue();
    });
    expect(new Uint8Array(await (await f.get(state)).arrayBuffer())).toEqual(bytes);
    expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
    expect(String(f.assetOwner.errors(state)[0])).toContain("already selected");
  }));

test("actual client abort rejects handoff but keeps callback debt until original release", () =>
  control(async (f) => {
    const state = await f.document();
    const entered = f.gate(),
      release = f.gate();
    let failure: unknown;
    hold(f, state, async (request) => {
      entered.resolve();
      await release.promise;
      try {
        await request.continue();
      } catch (error) {
        failure = error;
      }
    });
    const controller = new AbortController();
    const response = f.get(state, "", { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(response).rejects.toBeDefined();
    expect(await f.assetOwner.join(state, performance.now() + 100)).toBe(false);
    release.resolve();
    expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
    expect(failure).toBeInstanceOf(Error);
  }));

test(
  "held real GET survives Bun idle timeout and receives original complete bytes",
  () =>
    control(async (f) => {
      const state = await f.document();
      hold(f, state, async (request) => {
        await Bun.sleep(14_000);
        await request.continue();
      });
      const response = await f.get(state);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/wasm");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }),
  20_000,
);
