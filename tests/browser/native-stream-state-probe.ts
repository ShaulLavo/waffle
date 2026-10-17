import assert from "node:assert/strict";

const closedKey = Symbol.for("nodejs.webstream.isClosedPromise");
const errorKey = Symbol.for("nodejs.webstream.controllerErrorFunction");
const mode = process.argv[2];
const native = { ReadableStream, WritableStream, TransformStream };

if (mode === "own" || mode === "browser") {
  // Node 26 moved its hooks to prototype getters, so its default path would
  // otherwise hide the instance-property collision seen in Node 24 and 25.
  for (const Ctor of [ReadableStream, WritableStream]) {
    Reflect.deleteProperty(Ctor.prototype, closedKey);
    Reflect.deleteProperty(Ctor.prototype, errorKey);
  }
}
if (mode === "own") {
  for (const name of ["ReadableStream", "WritableStream"] as const) {
    const Ctor = globalThis[name];
    globalThis[name] = new Proxy(Ctor, {
      construct(target, args, newTarget) {
        const stream = Reflect.construct(target, args, newTarget);
        // Use assignment, just like the native Node 24/25 constructors.
        stream[closedKey] = { promise: Promise.resolve() };
        stream[errorKey] = () => {};
        return stream;
      },
    });
  }
}
const before = { ReadableStream, WritableStream, TransformStream };
const readable = new ReadableStream({ start(controller) { controller.close(); } });
const writable = new WritableStream();
const hooks = [Reflect.get(readable, closedKey), Reflect.get(writable, closedKey)];
const errorHooks = [Reflect.get(readable, errorKey), Reflect.get(writable, errorKey)];
const { installNativeStreamState } = await import("../src/native-stream-state.ts");
const dispose = installNativeStreamState();
try {
  const stream = new ReadableStream({ start(controller) { controller.close(); } });
  const hasNativeHooks = hooks[0] !== undefined;
  // The guest stream bindings validate capability on prototypes before loading.
  for (const Ctor of [ReadableStream, WritableStream]) {
    assert.ok(closedKey in Ctor.prototype);
    assert.ok(errorKey in Ctor.prototype);
  }
  for (const name of ["ReadableStream", "WritableStream", "TransformStream"] as const) {
    assert.equal(globalThis[name] === before[name], hasNativeHooks);
    assert.equal(globalThis[name].prototype, before[name].prototype);
  }
  if (hasNativeHooks) {
    assert.equal(Reflect.get(readable, closedKey), hooks[0]);
    assert.equal(Reflect.get(writable, closedKey), hooks[1]);
    assert.equal(Reflect.get(readable, errorKey), errorHooks[0]);
    assert.equal(Reflect.get(writable, errorKey), errorHooks[1]);
    if (mode === "own") {
      for (const stream of [readable, writable]) {
        assert.ok(Object.hasOwn(stream, closedKey));
        assert.ok(Object.hasOwn(stream, errorKey));
      }
    }
  }
  assert.ok(stream instanceof native.ReadableStream);
  assert.equal(stream.locked, false);
  await Reflect.get(stream, closedKey).promise;
  const sink = new WritableStream();
  await sink.close();
  await Reflect.get(sink, closedKey).promise;
  const transform = new TransformStream();
  const reader = transform.readable.getReader();
  const writer = transform.writable.getWriter();
  await writer.close();
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  writer.releaseLock();
  if (mode !== "own") {
    const errored = new ReadableStream();
    const failure = new Error("native bridge error");
    const completion = Reflect.get(errored, closedKey).promise;
    Reflect.apply(Reflect.get(errored, errorKey), errored, [failure]);
    await assert.rejects(completion, error => error === failure);
  }
} finally {
  dispose();
  await writable.close();
}
const installed = { ReadableStream, WritableStream, TransformStream };
const descriptors = [ReadableStream, WritableStream].map(Ctor =>
  [closedKey, errorKey].map(key => Object.getOwnPropertyDescriptor(Ctor.prototype, key)));
const disposeAgain = installNativeStreamState();
try {
  assert.deepEqual({ ReadableStream, WritableStream, TransformStream }, installed);
  assert.deepEqual([ReadableStream, WritableStream].map(Ctor =>
    [closedKey, errorKey].map(key => Object.getOwnPropertyDescriptor(Ctor.prototype, key))), descriptors);
} finally {
  disposeAgain();
}
console.log(`${mode}: native stream construction and completion passed on ${process.version}`);
