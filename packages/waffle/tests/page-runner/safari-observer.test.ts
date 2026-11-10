import { expect, test } from "bun:test";
import { SafariObserver, observationIdentityExpression } from "./safari-observer.js";
import { Frames, frame, isDict, type PlistDict } from "./inspector-plist.js";
import { inspectorEnvelope, type InspectorTransport } from "./inspector-stream.js";
import { HostConsumers } from "./owned-consumers.js";
import { record } from "./protocol.js";

const bootstrapURL = "https://owned.test/_waffle_observation_bootstrap?token=unique";
function fixture(
  options: {
    rejectEnable?: boolean;
    rejectInitialization?: boolean;
    pendingSend?: Promise<void>;
    pendingInit?: Promise<void>;
    omitOuter?: string;
    rejectOuter?: string;
  } = {},
) {
  const consumers = new HostConsumers();
  const abort = new AbortController();
  const observer = new SafariObserver({
    window: "driver-window",
    bootstrapURL,
    expectedURL: "https://owned.test/case",
    signal: abort.signal,
    consumers,
  });
  const frames = new Frames();
  let sequence = 0,
    connection = "",
    sender = "",
    detached = false;
  const methods: string[] = [];
  const initializationDispatched = Promise.withResolvers<void>();
  const feed = (value: PlistDict) => {
    const bytes = frame(value);
    // Every control uses the actual reused binary-plist streaming decoder, fragmented at byte 3.
    const accept = (value: unknown) => observer.accept(inspectorEnvelope(value, ++sequence));
    frames.feed(bytes.subarray(0, 3), accept);
    frames.feed(bytes.subarray(3), accept);
  };
  const envelope = (message: unknown) =>
    feed({
      __selector: "_rpc_applicationSentData:",
      __argument: {
        WIRApplicationIdentifierKey: "app",
        WIRDestinationKey: sender,
        WIRMessageDataKey: Buffer.from(JSON.stringify(message)),
      },
    });
  const inner = (message: unknown) =>
    envelope({
      method: "Target.dispatchMessageFromTarget",
      params: { targetId: "page-1", message: JSON.stringify(message) },
    });
  const event = (method: string, params: unknown) => inner({ method, params });
  const listing = () =>
    feed({
      __selector: "_rpc_applicationSentListing:",
      __argument: {
        WIRApplicationIdentifierKey: "app",
        WIRListingKey: {
          p: {
            WIRPageIdentifierKey: 7,
            WIRURLKey: bootstrapURL,
            WIRTypeKey: "WIRTypeWebPage",
            WIRConnectionIdentifierKey: detached ? "" : connection,
          },
        },
      },
    });
  const command = (args: PlistDict): Promise<void> => {
    if (!Buffer.isBuffer(args.WIRSocketDataKey)) throw new Error("Bad CPU request");
    const outer: unknown = JSON.parse(args.WIRSocketDataKey.toString());
    if (!record(outer) || !record(outer.params) || typeof outer.params.message !== "string")
      throw new Error("Bad CPU wrapper");
    const message: unknown = JSON.parse(outer.params.message);
    if (!record(message) || typeof message.method !== "string") throw new Error("Bad CPU command");
    methods.push(message.method);
    const result =
      message.method === "Runtime.evaluate"
        ? { result: { value: JSON.stringify({ url: bootstrapURL, marker: "unique" }) } }
        : {};
    if (message.method === "Worker.enable")
      event("Worker.workerCreated", { workerId: "first", url: "https://owned.test/worker.js" });
    if (
      (message.method === "Worker.enable" && options.rejectEnable) ||
      (message.method === "Worker.initialized" && options.rejectInitialization)
    )
      inner({ id: message.id, error: { code: -1, message: "domain refused" } });
    else inner({ id: message.id, result });
    if (message.method !== options.omitOuter)
      envelope(message.method === options.rejectOuter
        ? { id: outer.id, error: { code: -1, message: "outer refused" } }
        : { id: outer.id, result: {} });
    if (message.method === "Worker.initialized") {
      initializationDispatched.resolve();
      return options.pendingInit ?? Promise.resolve();
    }
    return options.pendingSend ?? Promise.resolve();
  };
  const transport: InspectorTransport = {
    async send(selector, args) {
      if (selector === "_rpc_reportIdentifier:") {
        connection = String(args.WIRConnectionIdentifierKey);
        feed({
          __selector: "_rpc_reportConnectedApplicationList:",
          __argument: { WIRApplicationDictionaryKey: { app: {} } },
        });
      }
      if (selector === "_rpc_forwardGetListing:") {
        const saved = connection;
        connection = "";
        listing();
        connection = saved;
      }
      if (selector === "_rpc_forwardSocketSetup:") {
        sender = String(args.WIRSenderKey);
        envelope({
          method: "Target.targetCreated",
          params: {
            targetInfo: { targetId: "page-1", type: "page", isProvisional: false, isPaused: false },
          },
        });
      }
      if (selector === "_rpc_forwardSocketData:") return command(args);
      if (selector === "_rpc_forwardDidClose:") {
        detached = true;
        listing();
      }
    },
    async close() {},
  };
  observer.connectTransport(transport);
  return { observer, consumers, abort, event, envelope, methods, initializationDispatched };
}

test("events during Worker.enable reduce before ack and initialized is promptly owned", async () => {
  const f = fixture();
  const ledger = await f.observer.attach();
  expect(ledger.workers()).toHaveLength(1);
  expect(f.methods).toEqual([
    "Runtime.evaluate",
    "Worker.enable",
    "Worker.initialized",
    "Network.enable",
  ]);
  f.event("Worker.workerCreated", { workerId: "second", url: "https://owned.test/worker.js" });
  const before = ledger.workers();
  expect(before).toHaveLength(2);
  expect(ledger.workers()[0]).toBe(before[0]);
  f.event("Worker.workerTerminated", { workerId: "first" });
  expect(ledger.workers()[0]).toBe(before[1]);
  f.event("Worker.workerTerminated", { workerId: "second" });
  await ledger.stop();
  expect(f.methods.slice(-2)).toEqual(["Network.disable", "Worker.disable"]);
  expect(await f.consumers.join(100)).toBe(true);
});

test("domain rejection is unqualified, not an empty worker set", async () => {
  const f = fixture({ rejectEnable: true });
  await expect(f.observer.attach()).rejects.toThrow();
  await expect(f.observer.close()).rejects.toThrow();
  expect(f.methods).not.toContain("Network.enable");
  expect(await f.consumers.join(100)).toBe(true);
});

test("abort never settles a real outstanding send or initialization promise", async () => {
  const send = Promise.withResolvers<void>();
  const f = fixture({ pendingInit: send.promise });
  const attaching = f.observer.attach().then(
    () => ({ kind: "ready" }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
  await f.initializationDispatched.promise;
  f.abort.abort();
  expect(await f.consumers.join(1)).toBe(false);
  send.resolve();
  expect((await attaching).kind).toBe("rejected");
  await f.observer.close();
  expect(f.methods).not.toContain("Network.enable");
  expect(await f.consumers.join(100)).toBe(true);
});

test("lost target and malformed selected payload never become zero workers", async () => {
  const f = fixture();
  const ledger = await f.observer.attach();
  f.envelope({
    method: "Target.targetCreated",
    params: { targetInfo: { targetId: "replacement", type: "page" } },
  });
  expect(() => ledger.workers()).toThrow("replaced");
  await expect(ledger.stop()).rejects.toThrow();
  const g = fixture();
  const other = await g.observer.attach();
  g.event("Worker.workerCreated", { workerId: 9 });
  expect(() => other.workers()).toThrow("worker ID");
  await expect(other.stop()).rejects.toThrow();
});

test("only the fixed read-only bootstrap identity expression exists", () => {
  expect(observationIdentityExpression).toBe(
    "JSON.stringify({url:location.href,marker:document.documentElement.getAttribute('data-waffle-observation')})",
  );
  expect(isDict({})).toBe(true);
});

test("missing navigation event at actual completion fails immediately, without a flush or retry", async () => {
  const f = fixture();
  const ledger = await f.observer.attach();
  expect(() => ledger.navigationComplete()).toThrow("not received at actual driver completion");
  expect(() => ledger.workers()).toThrow("Unqualified");
  await expect(ledger.stop()).rejects.toThrow();
});

test("navigation window binds actual frame/loader and refuses replacement documents", async () => {
  const f = fixture();
  const ledger = await f.observer.attach();
  f.event("Network.requestWillBeSent", {
    requestId: "navigation",
    frameId: "main",
    loaderId: "original",
    documentURL: "https://owned.test/case",
    request: { url: "https://owned.test/case" },
    timestamp: 1,
  });
  ledger.navigationComplete();
  f.event("Network.requestWillBeSent", {
    requestId: "payload",
    frameId: "main",
    loaderId: "original",
    documentURL: "https://owned.test/case",
    request: { url: "https://owned.test/python.wasm" },
    timestamp: 2,
  });
  const urls: string[] = [];
  ledger.onRequest((url) => {
    urls.push(url);
  });
  expect(urls).toEqual(["https://owned.test/case", "https://owned.test/python.wasm"]);
  f.event("Network.requestWillBeSent", {
    requestId: "replacement",
    frameId: "main",
    loaderId: "new-loader",
    documentURL: "https://owned.test/case",
    request: { url: "https://owned.test/case" },
    timestamp: 3,
  });
  expect(() => ledger.workers()).toThrow("lifetime replaced");
  await expect(ledger.stop()).rejects.toThrow();
});

test("startup continuation refusal fails admission once and leaves no invented Worker inventory", async () => {
  const f = fixture({ rejectInitialization: true });
  await expect(f.observer.attach()).rejects.toThrow();
  await expect(f.observer.close()).rejects.toThrow();
  expect(f.methods.filter((method) => method === "Worker.initialized")).toHaveLength(1);
  expect(f.methods).not.toContain("Network.enable");
  expect(await f.consumers.join(100)).toBe(true);
});

for (const method of ["Runtime.evaluate", "Worker.initialized", "Network.disable"]) {
  test(`missing outer ${method} reply prevents successful completion`, async () => {
    const f = fixture({ omitOuter: method });
    if (method === "Network.disable") {
      const ledger = await f.observer.attach();
      await expect(ledger.stop()).rejects.toThrow("completion uncertain");
    } else {
      await expect(f.observer.attach()).rejects.toThrow();
      await expect(f.observer.close()).rejects.toThrow();
    }
    expect(await f.consumers.join(100)).toBe(true);
  });
}

test("outer refusal after the inner answer still fails command completion", async () => {
  const f = fixture({ rejectOuter: "Network.disable" });
  const ledger = await f.observer.attach();
  await expect(ledger.stop()).rejects.toThrow("refused");
  expect(await f.consumers.join(100)).toBe(true);
});
