import { expect, test } from "bun:test";
import { installClientWorker, type ProcessWorkerBootstrapHost } from "./process-recycling-browser";

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
