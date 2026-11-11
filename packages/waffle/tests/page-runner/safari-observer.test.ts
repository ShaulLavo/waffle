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
    rejectPageEnable?: boolean;
    noWorkers?: boolean;
    rejectInitialization?: boolean;
    pendingSend?: Promise<void>;
    pendingInit?: Promise<void>;
    omitOuter?: string;
    rejectOuter?: string;
    delayOuterDisable?: Promise<void>;
    delayPageInner?: Promise<void>;
    delayPageOuter?: Promise<void>;
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
    detached = false,
    pageEnabled = false,
    networkEnabled = false;
  const methods: string[] = [];
  const lifecycle: string[] = [];
  const pageDispatched = Promise.withResolvers<void>();
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
  const inner = (message: unknown, targetId = "page-1") =>
    envelope({
      method: "Target.dispatchMessageFromTarget",
      params: { targetId, message: JSON.stringify(message) },
    });
  const event = (method: string, params: unknown) => inner({ method, params });
  const navigate = () => {
    if (!networkEnabled) throw new Error("CPU Network domain is disabled");
    // WebKit webkitgtk-2.50.0 PageNetworkAgent delegates both IDs to enabledPageAgent().
    event("Network.requestWillBeSent", {
      requestId: "navigation",
      frameId: pageEnabled ? "main" : "",
      loaderId: pageEnabled ? "original" : "",
      documentURL: "https://owned.test/case",
      type: "Document",
      request: { url: "https://owned.test/case", method: "GET" },
      timestamp: 1,
    });
  };
  const domain = (method: string) => {
    if (method === "Page.enable") {
      if (pageEnabled) throw new Error("CPU Page domain already enabled");
      pageEnabled = true;
      return;
    }
    if (method === "Page.disable") {
      if (!pageEnabled || networkEnabled) throw new Error("CPU Page disable order");
      pageEnabled = false;
      return;
    }
    if (method === "Network.enable") networkEnabled = true;
    if (method === "Network.disable") networkEnabled = false;
    if (
      ![
        "Runtime.evaluate",
        "Worker.enable",
        "Worker.disable",
        "Worker.initialized",
        "Network.enable",
        "Network.disable",
      ].includes(method)
    )
      throw new Error(`Unexpected CPU command: ${method}`);
  };
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
    lifecycle.push(message.method);
    const result =
      message.method === "Runtime.evaluate"
        ? { result: { value: JSON.stringify({ url: bootstrapURL, marker: "unique" }) } }
        : {};
    if (message.method === "Worker.enable" && !options.noWorkers)
      event("Worker.workerCreated", { workerId: "first", url: "https://owned.test/worker.js" });
    if (
      (message.method === "Worker.enable" && options.rejectEnable) ||
      (message.method === "Page.enable" && options.rejectPageEnable) ||
      (message.method === "Worker.initialized" && options.rejectInitialization)
    )
      inner({ id: message.id, error: { code: -1, message: "domain refused" } });
    else {
      domain(message.method);
      const answerInner = () => inner({ id: message.id, result });
      if (message.method === "Page.enable" && options.delayPageInner)
        void options.delayPageInner.then(answerInner);
      else answerInner();
    }
    const answerOuter = () =>
      envelope(
        message.method === options.rejectOuter
          ? { id: outer.id, error: { code: -1, message: "outer refused" } }
          : { id: outer.id, result: {} },
      );
    if (message.method === "Page.enable" && options.delayPageOuter)
      void options.delayPageOuter.then(answerOuter);
    else if (message.method === "Network.disable" && options.delayOuterDisable)
      void options.delayOuterDisable.then(answerOuter);
    else if (message.method !== options.omitOuter) answerOuter();
    if (message.method === "Page.enable") pageDispatched.resolve();
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
        if (pageEnabled || networkEnabled) throw new Error("CPU detach before domain disable");
        lifecycle.push("detach");
        detached = true;
        listing();
      }
    },
    async close() {
      lifecycle.push("close");
    },
  };
  observer.connectTransport(transport);
  return {
    observer,
    consumers,
    abort,
    event,
    inner,
    navigate,
    envelope,
    methods,
    lifecycle,
    pageDispatched,
    initializationDispatched,
  };
}

test("Page domain supplies real frame and loader IDs before the case navigation", async () => {
  const f = fixture({ noWorkers: true });
  const ledger = await f.observer.attach();
  f.navigate();
  try {
    ledger.navigationComplete();
    expect(ledger.evidence()).toMatchObject([{ frameId: "main", loaderId: "original" }]);
    expect(ledger.workers()).toEqual([]);
  } finally {
    await ledger.stop();
  }
  expect(await f.consumers.join(100)).toBe(true);
});

test("events during Worker.enable reduce before ack and initialized is promptly owned", async () => {
  const f = fixture();
  const ledger = await f.observer.attach();
  expect(ledger.workers()).toHaveLength(1);
  expect(f.methods).toEqual([
    "Runtime.evaluate",
    "Page.enable",
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
  expect(f.lifecycle.slice(-5)).toEqual([
    "Network.disable",
    "Worker.disable",
    "Page.disable",
    "detach",
    "close",
  ]);
  expect(await f.consumers.join(100)).toBe(true);
});

test("domain rejection is unqualified, not an empty worker set", async () => {
  const f = fixture({ rejectEnable: true });
  await expect(f.observer.attach()).rejects.toThrow();
  await expect(f.observer.close()).rejects.toThrow();
  expect(f.methods).not.toContain("Network.enable");
  expect(await f.consumers.join(100)).toBe(true);
});

test("Page enable refusal prevents admission and never claims a successful detach", async () => {
  const f = fixture({ rejectPageEnable: true });
  await expect(f.observer.attach()).rejects.toThrow("domain refused");
  await expect(f.observer.close()).rejects.toThrow("domain refused");
  expect(f.lifecycle).toEqual(["Runtime.evaluate", "Page.enable", "close"]);
  expect(await f.consumers.join(100)).toBe(true);
});

test("Page outer refusal after its inner success still prevents admission", async () => {
  const f = fixture({ rejectOuter: "Page.enable" });
  await expect(f.observer.attach()).rejects.toThrow("outer refused");
  await expect(f.observer.close()).rejects.toThrow("outer refused");
  expect(f.lifecycle).toEqual(["Runtime.evaluate", "Page.enable", "close"]);
  expect(await f.consumers.join(100)).toBe(true);
});

for (const answer of ["inner", "outer"]) {
  test(`Page enable waits for its ${answer} acknowledgement before Worker or Network admission`, async () => {
    const reply = Promise.withResolvers<void>();
    const f = fixture(
      answer === "inner" ? { delayPageInner: reply.promise } : { delayPageOuter: reply.promise },
    );
    let admitted = false;
    const attaching = f.observer.attach().then((ledger) => {
      admitted = true;
      return ledger;
    });
    await f.pageDispatched.promise;
    expect(admitted).toBe(false);
    expect(f.methods).toEqual(["Runtime.evaluate", "Page.enable"]);
    expect(await f.consumers.join(1)).toBe(false);
    reply.resolve();
    const ledger = await attaching;
    f.navigate();
    ledger.navigationComplete();
    await ledger.stop();
    expect(await f.consumers.join(100)).toBe(true);
  });
}

test("abort after acknowledged Page enable disables the known domain before detach", async () => {
  const reply = Promise.withResolvers<void>();
  const f = fixture({ delayPageOuter: reply.promise });
  const attaching = f.observer.attach().then(
    () => "ready",
    () => "rejected",
  );
  await f.pageDispatched.promise;
  f.abort.abort();
  reply.resolve();
  expect(await attaching).toBe("rejected");
  await f.observer.close();
  expect(f.lifecycle).toEqual([
    "Runtime.evaluate",
    "Page.enable",
    "Page.disable",
    "detach",
    "close",
  ]);
  expect(await f.consumers.join(100)).toBe(true);
});

for (const control of ["frame", "loader", "target", "document", "lifetime"]) {
  test(`enabled Page domain still rejects invalid ${control} request identity`, async () => {
    const f = fixture();
    const ledger = await f.observer.attach();
    f.navigate();
    ledger.navigationComplete();
    f.inner(
      {
        method: "Network.requestWillBeSent",
        params: {
          requestId: "payload",
          frameId: control === "frame" ? "" : "main",
          loaderId: control === "loader" ? "" : control === "lifetime" ? "replacement" : "original",
          documentURL:
            control === "document" ? "https://owned.test/other" : "https://owned.test/case",
          request: { url: "https://owned.test/payload.wasm" },
          timestamp: 2,
        },
      },
      control === "target" ? "other-page" : "page-1",
    );
    const errors: Record<string, string> = {
      frame: "Invalid Inspector frame ID",
      loader: "Invalid Inspector loader ID",
      target: "Inspector target lifetime changed",
      document: "Inspector request is outside the exact case document",
      lifetime: "Inspector document/frame lifetime replaced",
    };
    expect(() => ledger.evidence()).toThrow(errors[control]);
    await expect(ledger.stop()).rejects.toThrow(errors[control]);
    expect(await f.consumers.join(100)).toBe(true);
  });
}

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

for (const method of [
  "Runtime.evaluate",
  "Page.enable",
  "Worker.enable",
  "Worker.initialized",
  "Network.enable",
  "Network.disable",
  "Worker.disable",
  "Page.disable",
]) {
  test(`missing outer ${method} reply prevents successful completion`, async () => {
    const f = fixture({ omitOuter: method });
    if (method.endsWith(".disable")) {
      const ledger = await f.observer.attach();
      await expect(ledger.stop()).rejects.toThrow("timed out");
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

test("shutdown owns the outer reply after its inner answer and socket write complete", async () => {
  const outer = Promise.withResolvers<void>();
  const f = fixture({ delayOuterDisable: outer.promise });
  const ledger = await f.observer.attach();
  let settled = false;
  const stopped = ledger.stop();
  void stopped.then(() => {
    settled = true;
  });
  expect(await f.consumers.join(1)).toBe(false);
  expect(settled).toBe(false);
  expect(f.methods).not.toContain("Worker.disable");
  outer.resolve();
  await stopped;
  expect(await f.consumers.join(100)).toBe(true);
});

for (const order of ["before", "after"]) {
  test(`intentional exact target retirement preserves final browser close ${order} destruction`, async () => {
    const f = fixture();
    const ledger = await f.observer.attach();
    const worker = ledger.workers()[0]!;
    const received: string[] = [];
    ledger.onWorker((event) => {
      received.push(event.kind);
    });
    const closed = ledger.waitForWorkerClose(worker);
    ledger.beginDocumentClose();
    if (order === "before") f.event("Worker.workerTerminated", { workerId: "first" });
    f.envelope({ method: "Target.targetDestroyed", params: { targetId: "page-1" } });
    if (order === "after") f.event("Worker.workerTerminated", { workerId: "first" });
    await closed;
    expect(received).toEqual(["created", "closed"]);
    await ledger.stop();
    expect(f.lifecycle.at(-1)).toBe("close");
    expect(f.lifecycle.includes("detach")).toBe(false);
    expect(f.methods.includes("Worker.disable")).toBe(false);
    expect(await f.consumers.join(100)).toBe(true);
  });
}

test("matching page-listing removal preserves queued close but changed frontend still fails", async () => {
  const f = fixture();
  const ledger = await f.observer.attach();
  const worker = ledger.workers()[0]!;
  ledger.beginDocumentClose();
  f.observer.accept({
    selector: "_rpc_applicationSentListing:",
    argument: { WIRApplicationIdentifierKey: "app", WIRListingKey: {} },
    sequence: 100,
  });
  f.event("Worker.workerTerminated", { workerId: "first" });
  await ledger.waitForWorkerClose(worker);
  await ledger.stop();
  const replaced = fixture();
  const other = await replaced.observer.attach();
  other.beginDocumentClose();
  replaced.observer.accept({
    selector: "_rpc_applicationSentListing:",
    argument: {
      WIRApplicationIdentifierKey: "app",
      WIRListingKey: {
        p: { WIRPageIdentifierKey: 7, WIRConnectionIdentifierKey: "other-frontend" },
      },
    },
    sequence: 100,
  });
  expect((await other.failure).message).toContain("replaced");
  await expect(other.stop()).rejects.toThrow("replaced");
});

test("termination requests and wrong owners cannot supply a browser close", async () => {
  const f = fixture();
  const ledger = await f.observer.attach();
  const worker = ledger.workers()[0]!;
  let completed = false;
  const closed = ledger.waitForWorkerClose(worker).then(() => {
    completed = true;
  });
  f.event("Worker.terminate", { workerId: "first" });
  f.inner({ method: "Worker.workerTerminated", params: { workerId: "first" } }, "unrelated-target");
  await Promise.resolve();
  expect(completed).toBe(false);
  await expect(closed).rejects.toThrow("lifetime changed");
  await expect(ledger.stop()).rejects.toThrow("lifetime changed");
  const genuine = fixture();
  const accepted = await genuine.observer.attach();
  const actual = accepted.waitForWorkerClose(accepted.workers()[0]!);
  genuine.event("Worker.workerTerminated", { workerId: "first" });
  await actual;
  await accepted.stop();
});

test("stream loss and missing final close during owned destruction fail, never empty success", async () => {
  for (const loss of ["stream", "missing"]) {
    const f = fixture();
    const ledger = await f.observer.attach();
    const waiting = ledger.waitForWorkerClose(ledger.workers()[0]!);
    ledger.beginDocumentClose();
    f.envelope({ method: "Target.targetDestroyed", params: { targetId: "page-1" } });
    if (loss === "stream") f.observer.lose(new Error("stream lost"));
    const results = await Promise.allSettled([ledger.stop(), waiting]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(f.lifecycle.at(-1)).toBe("close");
    expect(await f.consumers.join(100)).toBe(true);
  }
});

test("pending lifecycle callbacks cannot delay Worker.initialized and must drain before transport stop", async () => {
  const f = fixture({ noWorkers: true });
  const ledger = await f.observer.attach();
  const callback = Promise.withResolvers<void>();
  const remove = ledger.onWorker(() => callback.promise);
  f.event("Worker.workerCreated", { workerId: "later", url: "https://owned.test/later.js" });
  await f.initializationDispatched.promise;
  expect(f.methods.at(-1)).toBe("Worker.initialized");
  const removed = remove();
  expect(remove()).toBe(removed);
  const stopped = ledger.stop();
  expect(await f.consumers.join(1)).toBe(false);
  expect(f.lifecycle.includes("Network.disable")).toBe(false);
  callback.resolve();
  await Promise.all([removed, stopped]);
  expect(f.lifecycle.at(-1)).toBe("close");
  expect(await f.consumers.join(100)).toBe(true);
});
