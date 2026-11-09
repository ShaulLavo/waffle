import { expect, test } from "bun:test";
import { get as httpGet } from "node:http";
import { Collector, type DocumentState } from "./collector.js";
import { HostConsumers } from "./owned-consumers.js";
import { serveCollector } from "./suite-host.js";
import type { AssetHoldCallback } from "./protocol.js";

const path = "/programs/shell-engine.wasm";
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 255, 0]);
function setup() {
  const collector = new Collector("run", ["A", "B"], ["A", "B"], {
    listIds: () => ["A", "B"],
    check() {},
  });
  const consumers = new HostConsumers();
  const hosted = serveCollector(
    collector,
    {
      [path]: new Blob([bytes], { type: "application/wasm" }),
      "/programs/test-guest.wasm": new Blob([bytes]),
      "/page.js": "export {};",
      "/ordinary.js": "original string",
      "/empty.wasm": new Blob([]),
    },
    undefined,
    0,
    undefined,
    consumers,
  );
  const date = { value: "Sat, 01 Jan 2000 00:00:00 GMT" };
  const respond = hosted.assetOwner.response.bind(hosted.assetOwner);
  hosted.assetOwner.response = async (...args) => {
    const requestedDate = date.value;
    const response = await respond(...args);
    response.headers.set("Date", requestedDate);
    return response;
  };
  const requests: Promise<Response>[] = [];
  const releases: (() => void)[] = [];
  async function document(id = "A", guard: () => void = () => {}) {
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
    hosted.assetOwner.bind(state, guard);
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
  return {
    ...hosted,
    collector,
    consumers,
    date,
    document,
    get,
    gate,
    close,
    cleanup: (action: () => void) => releases.push(action),
  };
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
function withAssets(run: (fixture: Fixture) => Promise<void>): () => Promise<void> {
  return () => control(run);
}
const continueAsset: AssetHoldCallback = async (request) => {
  await request.continue();
};
function throwingThen(failure: unknown, read: () => void): Promise<void> {
  // oxlint-disable-next-line unicorn/no-thenable -- Exercises callback assimilation failures.
  return Object.defineProperty(Promise.resolve(), "then", {
    get() {
      read();
      throw failure;
    },
  });
}
function oneGet(f: Fixture, state: DocumentState) {
  const result = Promise.withResolvers<{
    status: number | undefined;
    type: string | undefined;
    bytes: Uint8Array;
  }>();
  const client = httpGet(
    `${f.origin}${path}`,
    { agent: false, headers: { Referer: state.expectedURL } },
    (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", result.reject);
      response.on("end", () =>
        result.resolve({
          status: response.statusCode,
          type: response.headers["content-type"],
          bytes: Buffer.concat(chunks),
        }),
      );
    },
  );
  client.on("error", result.reject);
  f.cleanup(() => client.destroy());
  return result.promise;
}
function hold(f: Fixture, state: DocumentState, callback: AssetHoldCallback) {
  f.assetOwner.hold(state, path, callback);
}

test(
  "fixture supplies the Date header independently for distinct unheld and held requests",
  withAssets(async (f) => {
    const original = await f.get();
    expect(original.headers.get("Date")).toBe(f.date.value);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
    const state = await f.document();
    hold(f, state, continueAsset);
    f.date.value = "Mon, 01 Jan 2001 00:00:00 GMT";
    const held = await f.get(state);
    expect(held.headers.get("Date")).toBe(f.date.value);
    expect(held.headers.get("Date")).not.toBe(original.headers.get("Date"));
    expect(new Uint8Array(await held.arrayBuffer())).toEqual(bytes);
  }),
);

test(
  "held ordinary bytes, MIME, status and all headers match the unheld response",
  withAssets(async (f) => {
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
  }),
);

test(
  "continue hands off independently of callback completion and remains valid after revocation",
  withAssets(async (f) => {
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
  }),
);

test(
  "each repeated GET has its own once-only continuation",
  withAssets(async (f) => {
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
  }),
);

test(
  "duplicate HTML before protection fails registration, HEAD does not count",
  withAssets(async (f) => {
    const state = await f.document();
    expect((await fetch(state.expectedURL, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(state.expectedURL)).status).toBe(200);
    expect(() => hold(f, state, continueAsset)).toThrow("exactly one");
  }),
);

test(
  "protected HTML GET and HEAD fail closed and revoke new admissions",
  withAssets(async (f) => {
    const state = await f.document();
    hold(f, state, async (request) => {
      await request.continue();
    });
    const response = await fetch(state.expectedURL);
    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain("__suiteConfiguration=");
    expect((await fetch(state.expectedURL, { method: "HEAD" })).status).toBe(410);
    expect((await f.get(state)).status).toBe(410);
  }),
);

test(
  "protected asset HEAD is ordinary and no-hold current cases keep original responses",
  withAssets(async (f) => {
    const a = await f.document();
    hold(f, a, async (request) => {
      await request.continue();
    });
    expect((await f.get(undefined, "", { method: "HEAD" })).status).toBe(200);
    f.assetOwner.revoke(a);
    const b = await f.document("B");
    expect(new Uint8Array(await (await f.get(b)).arrayBuffer())).toEqual(bytes);
    expect((await f.get(a)).status).toBe(410);
  }),
);

for (const referer of [undefined, "http://wrong/", "origin", "missing-token"]) {
  test(
    `protected path rejects ${referer ?? "missing"} referrer without guessing active case`,
    withAssets(async (f) => {
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
    }),
  );
}

test(
  "query and stale physical, document and host states cannot admit protected requests",
  withAssets(async (f) => {
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
  }),
);

for (const failure of [undefined, null, false, 0, "", new Error("exact callback failure")]) {
  test(
    `synchronous callback failure preserves identity ${String(failure)}`,
    withAssets(async (f) => {
      const state = await f.document();
      hold(f, state, () => {
        throw failure;
      });
      expect((await f.get(state)).status).toBe(409);
      expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
      expect(f.assetOwner.errors(state)[0]).toBe(failure);
    }),
  );
}

test(
  "callback return without continue rejects handoff",
  withAssets(async (f) => {
    const a = await f.document();
    hold(f, a, async () => {});
    expect((await f.get(a)).status).toBe(409);
    expect(String(f.assetOwner.errors(a)[0])).toContain("without continue");
    f.assetOwner.revoke(a);
  }),
);

test(
  "after-continue failure cannot retract handed-off bytes",
  withAssets(async (f) => {
    const b = await f.document("B");
    const failure = new Error("after handoff");
    hold(f, b, async (request) => {
      await request.continue();
      throw failure;
    });
    expect(new Uint8Array(await (await f.get(b)).arrayBuffer())).toEqual(bytes);
    expect(await f.assetOwner.join(b, performance.now() + 500)).toBe(true);
    expect(f.assetOwner.errors(b)[0]).toBe(failure);
  }),
);

test(
  "double continue fails even when dropped, without a second response",
  withAssets(async (f) => {
    const state = await f.document();
    hold(f, state, async (request) => {
      void request.continue();
      void request.continue();
    });
    expect(new Uint8Array(await (await f.get(state)).arrayBuffer())).toEqual(bytes);
    expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
    expect(String(f.assetOwner.errors(state)[0])).toContain("already selected");
  }),
);

test(
  "actual client abort rejects handoff but keeps callback debt until original release",
  withAssets(async (f) => {
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
  }),
);

test(
  "held real GET survives Bun idle timeout and receives original complete bytes",
  withAssets(async (f) => {
    const state = await f.document();
    const release = f.gate();
    const timer = setTimeout(release.resolve, 14_000);
    f.cleanup(() => clearTimeout(timer));
    let calls = 0;
    hold(f, state, async (request) => {
      calls++;
      await release.promise;
      await request.continue();
    });
    const response = await oneGet(f, state);
    expect(response.status).toBe(200);
    expect(response.type).toBe("application/wasm");
    expect(new Uint8Array(response.bytes)).toEqual(bytes);
    expect(calls).toBe(1);
  }),
  20_000,
);

for (const thenable of [false, true]) {
  test(
    `asynchronous ${thenable ? "then accessor" : "rejection"} identity is preserved`,
    withAssets(async (f) => {
      const state = await f.document(),
        failure = { exact: "failure identity" };
      let reads = 0;
      hold(f, state, () => {
        if (!thenable) return Promise.reject(failure);
        return throwingThen(failure, () => {
          reads++;
        });
      });
      expect((await f.get(state)).status).toBe(409);
      expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
      expect(f.assetOwner.errors(state)[0]).toBe(failure);
      expect(reads).toBe(thenable ? 1 : 0);
    }),
  );
}
for (const invalid of [
  "/missing.wasm",
  "/",
  "/page.js",
  "/report",
  "/programs/*.wasm",
  `${path}?x=1`,
  `${path}#x`,
  "/programs/../shell.wasm",
  "//foreign/a",
]) {
  test(
    `registration rejects nonordinary or noncanonical path ${invalid}`,
    withAssets(async (f) => {
      const state = await f.document();
      expect(() => f.assetOwner.hold(state, invalid, continueAsset)).toThrow();
    }),
  );
}
test(
  "registration rejects duplicate paths, worker scripts and revoked host capabilities",
  withAssets(async (f) => {
    const state = await f.document();
    f.collector.declareWorker("A", {
      kind: "service-worker",
      name: `${f.origin}/scope/`,
      clientURL: state.expectedURL,
      scriptURL: `${f.origin}/ordinary.js?waffle-run=run`,
    });
    expect(() => f.assetOwner.hold(state, "/ordinary.js", continueAsset)).toThrow("ordinary asset");
    hold(f, state, continueAsset);
    expect(() => hold(f, state, continueAsset)).toThrow("already registered");
    f.assetOwner.revoke(state);
    expect(() => f.assetOwner.hold(state, "/programs/test-guest.wasm", continueAsset)).toThrow();
  }),
);
for (const guard of [
  "cutoff",
  "complete",
  "physical",
  "host",
  "role",
  "execution",
  "outcome",
  "body",
]) {
  test(
    `protected admission checks actual ${guard} state`,
    withAssets(async (f) => {
      let revoked = false,
        calls = 0;
      const state = await f.document("A", () => {
        if (revoked) throw new Error("body revoked");
      });
      hold(f, state, async (request) => {
        calls++;
        await request.continue();
      });
      if (guard === "cutoff") state.cutoff = 0;
      if (guard === "complete") state.complete = true;
      if (guard === "physical") state.physical = "unconfirmed";
      if (guard === "host") state.host = { kind: "teardown", enteredAt: performance.now() };
      if (guard === "role") state.group.role = "list";
      if (guard === "execution") state.group.execution = undefined;
      if (guard === "outcome") f.collector.outcomes.A = { status: "pass", provisional: false };
      if (guard === "body") revoked = true;
      expect((await f.get(state)).status).toBe(guard === "body" ? 409 : 410);
      expect(calls).toBe(0);
    }),
  );
}
test(
  "unheld strings, missing assets and service worker headers keep normal construction",
  withAssets(async (f) => {
    const state = await f.document();
    const script = await fetch(`${f.origin}/ordinary.js`);
    expect(await script.text()).toBe("original string");
    expect(script.headers.get("Content-Type")).toBe("application/javascript");
    const missing = await fetch(`${f.origin}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("Not found");
    const guest = await fetch(`${f.origin}/programs/test-guest.wasm`);
    expect(guest.headers.get("Content-Type")).toBe("application/octet-stream");
    f.collector.declareWorker("A", {
      kind: "service-worker",
      name: `${f.origin}/scope/`,
      clientURL: state.expectedURL,
      scriptURL: `${f.origin}/ordinary.js?waffle-run=run`,
    });
    const worker = await fetch(`${f.origin}/ordinary.js?waffle-run=run`);
    expect(worker.headers.get("Service-Worker-Allowed")).toBe(`${f.origin}/scope/`);
    expect((await fetch(`${f.origin}/ordinary.js?waffle-run=other`)).status).toBe(404);
  }),
);

test(
  "the normal Response is constructed once and the same object reaches the handler handoff",
  withAssets(async (f) => {
    const state = await f.document();
    const NativeResponse = globalThis.Response;
    const constructed: Response[] = [];
    const normal = f.assetOwner.response.bind(f.assetOwner);
    let handed: Response | Promise<Response> | undefined;
    f.assetOwner.response = (...args) => {
      handed = normal(...args);
      return handed;
    };
    globalThis.Response = new Proxy(NativeResponse, {
      construct(target, args, newTarget) {
        const response: unknown = Reflect.construct(target, args, newTarget);
        if (!(response instanceof NativeResponse)) throw new Error("Invalid Response constructor");
        constructed.push(response);
        return response;
      },
    });
    try {
      hold(f, state, continueAsset);
      expect(new Uint8Array(await (await f.get(state)).arrayBuffer())).toEqual(bytes);
      expect(constructed).toHaveLength(1);
      expect(await handed).toBe(constructed[0]);
    } finally {
      globalThis.Response = NativeResponse;
      f.assetOwner.response = normal;
    }
  }),
);

test(
  "held string and empty Blob keep their original representation and MIME",
  withAssets(async (f) => {
    const state = await f.document();
    f.assetOwner.hold(state, "/ordinary.js", continueAsset);
    f.assetOwner.hold(state, "/empty.wasm", continueAsset);
    const headers = { Referer: state.expectedURL };
    const string = await fetch(`${f.origin}/ordinary.js`, { headers });
    expect(string.status).toBe(200);
    expect(string.headers.get("Content-Type")).toBe("application/javascript");
    expect(await string.text()).toBe("original string");
    const empty = await fetch(`${f.origin}/empty.wasm`, { headers });
    expect(empty.status).toBe(200);
    expect(empty.headers.get("Content-Type")).toBe("application/octet-stream");
    expect((await empty.arrayBuffer()).byteLength).toBe(0);
  }),
);

test(
  "HEAD before first protection is not a second executable delivery",
  withAssets(async (f) => {
    const state = await f.document();
    await fetch(state.expectedURL, { method: "HEAD" });
    expect(() => hold(f, state, continueAsset)).not.toThrow();
    expect((await f.get(state)).status).toBe(200);
  }),
);

test(
  "body revocation before callback resumes denies new work but cannot revoke admitted continuation",
  withAssets(async (f) => {
    const state = await f.document();
    const normal = f.assetOwner.response.bind(f.assetOwner);
    f.assetOwner.response = (...args) => {
      const response = normal(...args);
      f.assetOwner.revoke(state);
      return response;
    };
    let entered = false;
    hold(f, state, async (request) => {
      entered = true;
      await request.continue();
    });
    expect(new Uint8Array(await (await f.get(state)).arrayBuffer())).toEqual(bytes);
    expect(entered).toBe(true);
    expect((await f.get(state)).status).toBe(410);
  }),
);

test(
  "sealing keeps late callback failure out of the saved verdict while retaining its actual identity",
  withAssets(async (f) => {
    const state = await f.document(),
      release = f.gate(),
      failure = new Error("late failure");
    hold(f, state, async (request) => {
      await request.continue();
      await release.promise;
      throw failure;
    });
    expect((await f.get(state)).status).toBe(200);
    f.assetOwner.seal();
    const failures = f.collector.failures.slice();
    release.resolve();
    expect(await f.assetOwner.join(state, performance.now() + 500)).toBe(true);
    expect(f.collector.failures).toEqual(failures);
    expect(f.assetOwner.errors(state)[0]).toBe(failure);
  }),
);
