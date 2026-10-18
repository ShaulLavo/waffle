import { expect, test } from "bun:test";
import { installClientWorker, ProcessWorker, type ProcessWorkerBootstrapHost } from "./process-recycling-browser";
import { closeBrowserResources, stopBrowserResource, type BrowserResourceOwner } from "./process-recycling-browser-runner-control";
import { createWorkerProcessTransport } from "../proc/worker-client";

type FixtureModule = { installProcessTestWorker(): void };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function hostFixture() {
  const messages: unknown[] = [];
  const listeners = new Map<string, (event: Event) => void>();
  const host: ProcessWorkerBootstrapHost = {
    onmessage: null,
    postMessage(message) { messages.push(message); },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  return { host, messages, emit(type: string, fields: Record<string, unknown>) {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    listeners.get(type)!(event);
    return event;
  } };
}
function message(id: number): MessageEvent { return { data: { id, operation: "init" } } as MessageEvent; }
function emittedBootstrap(): typeof installClientWorker {
  // This is exactly the runner's source-generation boundary, without importing the runner
  // (which would launch browsers). No module-scope dependency may leak into emitted code.
  return new Function(`return (${installClientWorker.toString()});`)() as typeof installClientWorker;
}

test("emitted Worker bootstrap buffers early init exactly once and preserves message order", async () => {
  const { host, messages } = hostFixture(), imported = deferred<FixtureModule>();
  const delivered: MessageEvent[] = [];
  const bootstrap = emittedBootstrap()(host, () => imported.promise);
  const first = message(1), second = message(2), third = message(3);
  expect(host.onmessage).not.toBeNull();
  host.onmessage!(first); host.onmessage!(second);
  expect(delivered).toEqual([]);
  imported.resolve({ installProcessTestWorker() {
    host.onmessage = event => { delivered.push(event); };
  } });
  await bootstrap;
  host.onmessage!(third);
  expect(delivered).toEqual([first, second, third]);
  expect(delivered[0]).toBe(first);
  expect(delivered[1]).toBe(second);
  expect(delivered[2]).toBe(third);
  expect(messages).toEqual([]);
});

test("Worker bootstrap reports rejected import immediately instead of losing early init", async () => {
  const { host, messages } = hostFixture(), imported = deferred<FixtureModule>();
  const failure = new Error("fixture module import rejected");
  const bootstrap = emittedBootstrap()(host, () => imported.promise);
  host.onmessage!(message(1));
  imported.reject(failure);
  await bootstrap;
  expect(messages).toEqual([{ type: "process-test-fatal", error: {
    name: "Error", message: `Process Worker bootstrap failed: ${failure.message}`, stack: failure.stack,
  } }]);
});

test("Worker bootstrap reports fixture installation exception", async () => {
  const { host, messages } = hostFixture();
  const failure = new TypeError("fixture install failed");
  await emittedBootstrap()(host, async () => ({ installProcessTestWorker() { throw failure; } }));
  expect(messages).toEqual([{ type: "process-test-fatal", error: {
    name: "TypeError", message: `Process Worker bootstrap failed: ${failure.message}`, stack: failure.stack,
  } }]);
});

test("Worker bootstrap rejects a fixture that leaves the temporary buffer installed", async () => {
  const { host, messages } = hostFixture();
  await emittedBootstrap()(host, async () => ({ installProcessTestWorker() {} }));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: "process-test-fatal", error: {
    message: "Process Worker bootstrap failed: Process fixture did not install a message handler",
  } });
});

test("Worker bootstrap reports an exception while dispatching buffered init without duplicate dispatch", async () => {
  const { host, messages } = hostFixture(), imported = deferred<FixtureModule>();
  const delivered: number[] = [], failure = new Error("queued init failed");
  const bootstrap = emittedBootstrap()(host, () => imported.promise);
  host.onmessage!(message(1)); host.onmessage!(message(2));
  imported.resolve({ installProcessTestWorker() {
    host.onmessage = event => { delivered.push(event.data.id); throw failure; };
  } });
  await bootstrap;
  expect(delivered).toEqual([1]);
  expect(messages).toEqual([{ type: "process-test-fatal", error: {
    name: "Error", message: `Process Worker bootstrap failed: ${failure.message}`, stack: failure.stack,
  } }]);
});

test("Worker bootstrap forwards uncaught errors and unhandled rejections with original details", async () => {
  const { host, messages, emit } = hostFixture();
  await emittedBootstrap()(host, async () => ({ installProcessTestWorker() { host.onmessage = () => {}; } }));
  const failure = new Error("worker checkpoint failed");
  const uncaught = emit("error", { error: failure });
  const rejection = emit("unhandledrejection", { reason: failure });
  const location = emit("error", { message: "script unavailable", filename: "/fixture.js", lineno: 4, colno: 2 });
  expect(messages).toHaveLength(3);
  expect(messages[0]).toMatchObject({ type: "process-test-fatal", error: {
    name: "Error", message: `Process Worker uncaught error: ${failure.message}`, stack: failure.stack,
  } });
  expect(messages[1]).toMatchObject({ type: "process-test-fatal", error: {
    name: "Error", message: `Process Worker unhandled rejection: ${failure.message}`, stack: failure.stack,
  } });
  expect(messages[2]).toMatchObject({ type: "process-test-fatal", error: {
    message: "Process Worker uncaught error: script unavailable at /fixture.js:4:2",
  } });
  expect([uncaught.defaultPrevented, rejection.defaultPrevented, location.defaultPrevented]).toEqual([true, true, true]);
});

function workerFixture() {
  const errors: Error[] = [];
  let terminated = 0;
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(message: { id: number; operation: string }) {
      if (message.operation === "init") this.onmessage!({ data: { id: message.id, result: { isolated: true, shared: true } } } as MessageEvent);
    },
    terminate() { terminated++; },
  };
  const transport = createWorkerProcessTransport({ pid: 1, job: 1, capacity: 2 });
  const client = new ProcessWorker(transport, () => {}, error => { errors.push(error); }, () => worker as unknown as Worker);
  return { client, worker, errors, terminated: () => terminated };
}

for (const kind of ["fatal", "error", "decode"] as const) {
  test(`unexpected Worker ${kind} between completed RPCs fails its case exactly once`, async () => {
    const { client, worker, errors, terminated } = workerFixture();
    await client.start();
    try {
      const fatal = () => worker.onmessage!({ data: { type: "process-test-fatal", error: {
        name: "TypeError", message: "idle Worker failed", stack: "original-worker-stack",
      } } } as MessageEvent);
      if (kind === "fatal") fatal();
      else if (kind === "error") worker.onerror!({ preventDefault() {}, message: "idle Worker failed", filename: "/tests.js", lineno: 4, colno: 2 } as ErrorEvent);
      else worker.onmessageerror!();
      fatal(); // Native error plus forwarded fatal must not double-report.
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain(kind === "decode" ? "could not be decoded" : "idle Worker failed");
      if (kind === "fatal") expect(errors[0]).toMatchObject({ name: "TypeError", stack: "original-worker-stack" });
      expect(terminated()).toBe(1);
      await expect(client.request({ operation: "snapshot" })).rejects.toBe(errors[0]);
    } finally { client.stop(); }
  });
}

test("intentional Worker stop rejects outstanding RPCs without reporting an unexpected failure", async () => {
  const { client, errors, terminated } = workerFixture();
  await client.start();
  const pending = client.request({ operation: "snapshot" });
  client.stop(); client.stop();
  await expect(pending).rejects.toThrow("teardown");
  expect(errors).toEqual([]);
  expect(terminated()).toBe(1);
});

function resource(creation: BrowserResourceOwner["creation"]): BrowserResourceOwner {
  return { creation, stopped: false };
}

for (const phase of ["creation", "closure"] as const) {
  test(`stalled context ${phase} cannot block browser shutdown`, async () => {
    const stalled = deferred<{ close(): Promise<void> }>();
    const context = resource(phase === "creation" ? stalled.promise : Promise.resolve({ close: () => new Promise<void>(() => {}) }));
    let browserClosed = 0;
    const browser = resource(Promise.resolve({ async close() { browserClosed++; } }));
    const contexts = new Set([context]), browsers = new Set([browser]);
    const errors = await closeBrowserResources(contexts, browsers, 5);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain(`resource ${phase}`);
    expect(browserClosed).toBe(1);
    expect(browser.stopped).toBe(true);
    expect(browsers.size).toBe(0);
    expect(contexts.size).toBe(0);
    if (phase === "creation") stalled.resolve({ async close() {} });
  });
}

test("unconfirmed browser shutdown retains ownership instead of declaring scratch disposable", async () => {
  const browser = resource(Promise.resolve({ close: () => new Promise<void>(() => {}) }));
  const browsers = new Set([browser]);
  const errors = await closeBrowserResources(new Set<BrowserResourceOwner>(), browsers, 5);
  expect(errors).toHaveLength(1);
  expect(browser.stopped).toBe(false);
  expect(browsers.has(browser)).toBe(true);
});

test("timed-out browser creation remains attached to eventual teardown", async () => {
  const creation = deferred<{ close(): Promise<void> }>();
  const browser = resource(creation.promise), browsers = new Set([browser]);
  await expect(stopBrowserResource(browsers, browser, 5)).rejects.toThrow("resource creation");
  expect(browsers.has(browser)).toBe(true);
  let closed = 0;
  creation.resolve({ async close() { closed++; } });
  await creation.promise;
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toBe(1);
  expect(browser.stopped).toBe(true);
  expect(browsers.size).toBe(0);
});

test("concurrent normal and signal teardown close each resource once", async () => {
  const closing = deferred<void>();
  let closed = 0;
  const browser = resource(Promise.resolve({ close() { closed++; return closing.promise; } }));
  const browsers = new Set([browser]);
  const first = stopBrowserResource(browsers, browser, 100);
  const second = stopBrowserResource(browsers, browser, 100);
  expect(first).toBe(second);
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toBe(1);
  closing.resolve();
  await Promise.all([first, second]);
  expect(browsers.size).toBe(0);
});
