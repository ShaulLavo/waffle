import { expect, test } from "bun:test";
import { RuntimeWorkerSignal } from "../browser/worker.js";
import { WasiExit } from "../core/index.js";
import { ProcessSignalExit } from "../proc/abi.js";
import { importUnwind } from "./fixtures/gpu/import-unwind.js";
import { thrownObservation } from "./fixtures/gpu/thrown-observation.js";

let deliver: (message: unknown) => void = () => {};
async function loadFixture() {
  const post = Object.getOwnPropertyDescriptor(globalThis, "postMessage");
  const onmessage = Object.getOwnPropertyDescriptor(globalThis, "onmessage");
  Object.defineProperty(globalThis, "postMessage", {
    configurable: true,
    value: (message: unknown) => deliver(message),
  });
  try {
    const fixture = await import("./fixtures/gpu/integration-guest.js");
    const { poisonProcessIntrinsics } = await import("./fixtures/process-intrinsics.js");
    return { observedImport: fixture.observedImport, poisonProcessIntrinsics };
  } finally {
    if (post) Object.defineProperty(globalThis, "postMessage", post);
    else Reflect.deleteProperty(globalThis, "postMessage");
    if (onmessage) Object.defineProperty(globalThis, "onmessage", onmessage);
    else Reflect.deleteProperty(globalThis, "onmessage");
  }
}
const { observedImport, poisonProcessIntrinsics } = await loadFixture();

function rig(original: Function) {
  const events: unknown[] = [];
  deliver = (message) => events.push(message);
  const invoke = observedImport(
    original,
    "test-token",
    "completions",
    undefined,
    { enabled: false, memory: () => undefined },
    () => undefined,
  );
  return { events, invoke };
}
function caught(invoke: () => unknown): unknown {
  try {
    invoke();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the observed call to throw");
}

test("unclassified import throw retains its value and bounded native error details", () => {
  const error = new TypeError("control cells collected");
  const { events, invoke } = rig(() => {
    throw error;
  });
  expect(caught(invoke)).toBe(error);
  expect(events.at(-1)).toMatchObject({
    gpuImport: {
      token: "test-token",
      call: expect.any(Number),
      name: "completions",
      phase: "throw",
      unwind: undefined,
      exception: {
        site: "import",
        valueType: "object",
        name: "TypeError",
        message: "control cells collected",
        stack: expect.stringContaining("gpu-import-observation.test.ts"),
      },
    },
  });
});

test("successful calls preserve receiver, arguments, result, and return observations", () => {
  const receiver = { result: 17 };
  const seen: unknown[] = [];
  const { events, invoke } = rig(function (this: typeof receiver, ...args: unknown[]) {
    seen.push(this, args);
    return this.result;
  });
  expect(invoke.call(receiver, 2, 3n)).toBe(17);
  expect(seen).toEqual([receiver, [2, 3n]]);
  expect(events).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ gpuImport: { phase: "return", result: 17 } });
  expect(JSON.stringify(events)).not.toContain("exception");
});

test.each([new RuntimeWorkerSignal(9), new ProcessSignalExit(9), new WasiExit(1)])(
  "recognized import unwind observations stay unchanged",
  (error) => {
    const { events, invoke } = rig(() => {
      throw error;
    });
    expect(caught(invoke)).toBe(error);
    expect(events.at(-1)).toEqual({
      gpuImport: {
        token: "test-token",
        call: expect.any(Number),
        name: "completions",
        phase: "throw",
        unwind: importUnwind(error),
      },
    });
  },
);

test("return telemetry failure is not attributed to the import, even for a real unwind", () => {
  const error = new WasiExit(1);
  const { events, invoke } = rig(() => 0);
  let deliveries = 0;
  deliver = (message) => {
    deliveries++;
    if (deliveries === 2) throw error;
    events.push(message);
  };
  expect(caught(invoke)).toBe(error);
  expect(events.at(-1)).toMatchObject({
    gpuImport: { phase: "throw", unwind: undefined, exception: { site: "return-observer" } },
  });
});

test("return observation failure is distinguished before telemetry sends", () => {
  const events: unknown[] = [];
  deliver = (message) => events.push(message);
  const invoke = observedImport(
    () => 0,
    "test-token",
    "completions",
    undefined,
    { enabled: true, memory: () => undefined },
    () => undefined,
  );
  const error = caught(invoke);
  expect(error).toBeInstanceOf(Error);
  expect(events.at(-1)).toMatchObject({
    gpuImport: {
      phase: "throw",
      exception: { site: "return-observer", message: "Missing completion import memory" },
    },
  });
});

test("throw telemetry failure never replaces the original value", () => {
  const error = new Error("original import error");
  const { events, invoke } = rig(() => {
    throw error;
  });
  let deliveries = 0;
  deliver = (message) => {
    if (++deliveries > 1) throw new Error("diagnostic send failure");
    events.push(message);
  };
  expect(caught(invoke)).toBe(error);
  expect(events).toHaveLength(1);
});

test("classification failure cannot replace an opaque thrown proxy", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const { events, invoke } = rig(() => {
    throw revoked.proxy;
  });
  expect(caught(invoke)).toBe(revoked.proxy);
  expect(events.at(-1)).toMatchObject({
    gpuImport: { unwind: undefined, exception: { site: "import", valueType: "object" } },
  });
});

test.each([
  [undefined, "undefined", undefined],
  [null, "null", null],
  [false, "boolean", false],
  [23, "number", "23"],
  [-0, "number", "-0"],
  [NaN, "number", "NaN"],
  [Infinity, "number", "Infinity"],
  [-Infinity, "number", "-Infinity"],
  ["native text", "string", "native text"],
  [1n << 100_000n, "bigint", undefined],
  [Symbol("opaque"), "symbol", undefined],
  [() => {}, "function", undefined],
] as const)(
  "primitive throw case %# has a bounded scalar representation",
  (value, valueType, detail) => {
    const { events, invoke } = rig(() => {
      throw value;
    });
    expect(caught(invoke)).toBe(value);
    expect(events.at(-1)).toMatchObject({
      gpuImport: { exception: { site: "import", valueType } },
    });
    const observation = thrownObservation(value, "import");
    expect(observation.value).toBe(detail);
    expect(JSON.stringify(observation).length).toBeLessThan(600);
  },
);

test("unknown objects do not serialize private values or invoke getters and coercions", () => {
  let calls = 0;
  const fail = () => {
    calls++;
    throw new Error("guest hook invoked");
  };
  const value = {
    get name() {
      return fail();
    },
    get message() {
      return fail();
    },
    get stack() {
      return fail();
    },
    toString: fail,
    toJSON: fail,
    [Symbol.toPrimitive]: fail,
    privateBuffers: [new SharedArrayBuffer(4096)],
    privateAuthority: { signal: 9 },
  };
  expect(thrownObservation(value, "import")).toEqual({
    site: "import",
    valueType: "object",
  });
  expect(calls).toBe(0);
  expect(thrownObservation(Object.create(null), "import").valueType).toBe("object");
});

test("native errors with unsafe formatting properties do not invoke those properties", () => {
  let calls = 0;
  const error = new Error("safe");
  Object.defineProperty(error, "name", {
    get() {
      calls++;
      throw new Error("name getter invoked");
    },
  });
  Object.defineProperty(error, "message", {
    value: {
      toString() {
        calls++;
        throw new Error("message coercion invoked");
      },
    },
  });
  const observation = thrownObservation(error, "import");
  expect(observation.name).toBeUndefined();
  expect(observation.message).toBeUndefined();
  expect(observation.stack).toBeUndefined();
  expect(calls).toBe(0);
});

test("oversized strings and stacks have fixed output limits without losing the first frames", () => {
  const value = Object.assign(new Error(), {
    name: "n".repeat(10_000),
    message: "m".repeat(100_000),
    stack:
      "headline".repeat(10_000) +
      "\n" +
      Array.from({ length: 100 }, (_, i) => `at frame${i} ` + "f".repeat(10_000)).join("\n"),
  });
  const observation = thrownObservation(value, "import");
  expect(observation.name).toHaveLength(80);
  expect(observation.message).toHaveLength(512);
  expect(observation.stack?.split("\n")).toHaveLength(5);
  expect(observation.stack?.length).toBeLessThanOrEqual(1284);
  expect(observation.stack).toContain("at frame3");
  expect(observation.stack).not.toContain("at frame4");
  expect(thrownObservation("s".repeat(100_000), "import").value).toHaveLength(512);
});

test("unclassified observation works while the exact intrinsic-poison fixture is active", () => {
  const error = new TypeError("control cells collected under poison");
  const { events, invoke } = rig(() => {
    throw error;
  });
  const poison = poisonProcessIntrinsics([]);
  let thrown: unknown;
  let report: ReturnType<typeof poison.restore>;
  try {
    thrown = caught(invoke);
  } finally {
    report = poison.restore();
  }
  expect(thrown).toBe(error);
  expect(report.leaks).toEqual([]);
  expect(report.canaries.length).toBeGreaterThan(0);
  expect(events.at(-1)).toMatchObject({
    gpuImport: {
      unwind: undefined,
      exception: { name: "TypeError", message: error.message, stack: expect.any(String) },
    },
  });
});

test("an error-shaped object is observed but never classified by its name", () => {
  const value = { name: "RuntimeWorkerSignal", message: "not a runtime unwind", signal: 9 };
  const { events, invoke } = rig(() => {
    throw value;
  });
  expect(caught(invoke)).toBe(value);
  expect(events.at(-1)).toMatchObject({
    gpuImport: {
      unwind: undefined,
      exception: { valueType: "object" },
    },
  });
});

test("an arbitrary stack getter is never called", () => {
  let calls = 0;
  const value = {
    get stack() {
      calls++;
      throw new Error("stack getter invoked");
    },
  };
  expect(thrownObservation(value, "import").stack).toBeUndefined();
  expect(calls).toBe(0);
});

test("a failure sending the diagnostic cannot replace a return observer exception", () => {
  const error = new Error("original return telemetry error");
  const { events, invoke } = rig(() => 0);
  let deliveries = 0;
  deliver = (message) => {
    if (++deliveries === 2) throw error;
    if (deliveries > 2) throw new Error("diagnostic send failure");
    events.push(message);
  };
  expect(caught(invoke)).toBe(error);
  expect(events).toHaveLength(1);
});

test("opaque objects and error proxies are not reflected to format diagnostics", () => {
  let calls = 0;
  const traps = {
    getOwnPropertyDescriptor() {
      calls++;
      throw new Error("descriptor trap invoked");
    },
    getPrototypeOf() {
      calls++;
      throw new Error("prototype trap invoked");
    },
    get() {
      calls++;
      throw new Error("get trap invoked");
    },
  };
  expect(thrownObservation(new Proxy({}, traps), "import")).toEqual({
    site: "import",
    valueType: "object",
  });
  expect(thrownObservation(new Proxy(new Error(), traps), "import")).toEqual({
    site: "import",
    valueType: "object",
  });
  const error = new Error("native error with opaque prototype");
  Object.setPrototypeOf(error, new Proxy({}, traps));
  expect(thrownObservation(error, "import").stack).toBeUndefined();
  expect(calls).toBe(0);
});

test("guest stack formatters are not called to collect native error frames", () => {
  const prepare = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  let calls = 0;
  let stack: string | undefined;
  Object.defineProperty(Error, "prepareStackTrace", {
    configurable: true,
    get() {
      calls++;
      throw new Error("guest formatter getter invoked");
    },
  });
  try {
    stack = thrownObservation(new Error("native message"), "import").stack;
  } finally {
    if (prepare) Object.defineProperty(Error, "prepareStackTrace", prepare);
    else Reflect.deleteProperty(Error, "prepareStackTrace");
  }
  expect(stack).toBeUndefined();
  expect(calls).toBe(0);
});

const nativeOwnDescriptor = Object.getOwnPropertyDescriptor;
const nativeDefine = Object.defineProperty;
const nativeDelete = Reflect.deleteProperty;
const nativeSetPrototype = Object.setPrototypeOf;
function installOwnDescriptor(target: object, key: PropertyKey, field: PropertyDescriptor) {
  nativeSetPrototype(field, null);
  nativeDefine(target, key, field);
}
function restorePrototypeField(key: PropertyKey, field: PropertyDescriptor | undefined) {
  nativeDelete(Object.prototype, key);
  if (field) installOwnDescriptor(Object.prototype, key, field);
}

test("inherited descriptor fields cannot run getters or forge exception metadata", () => {
  const error = new Error("safe message");
  let nameCalls = 0,
    descriptorCalls = 0;
  installOwnDescriptor(error, "name", {
    configurable: true,
    get() {
      nameCalls++;
      return "name-hook";
    },
  });
  const saved = nativeOwnDescriptor(Object.prototype, "value"),
    { events, invoke } = rig(() => {
      throw error;
    });
  let result: ReturnType<typeof thrownObservation>, original: unknown;
  installOwnDescriptor(Object.prototype, "value", {
    configurable: true,
    get() {
      descriptorCalls++;
      return "descriptor-hook";
    },
  });
  try {
    result = thrownObservation(error, "import");
    original = caught(invoke);
  } finally {
    restorePrototypeField("value", saved);
  }
  expect(original).toBe(error);
  expect(nameCalls).toBe(0);
  expect(descriptorCalls).toBe(0);
  expect(result.name).toBeUndefined();
  expect(result.stack).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain("descriptor-hook");
});

for (const field of ["name", "message", "stack"] as const)
  test(`inherited output ${field} setters cannot insert arbitrary objects or views`, () => {
    const error = new TypeError("safe message"),
      saved = nativeOwnDescriptor(Object.prototype, field),
      arbitrary = { marker: "not a scalar", view: new Int32Array(new SharedArrayBuffer(16)) },
      { events, invoke } = rig(() => {
        throw error;
      });
    let calls = 0,
      original: unknown,
      result: ReturnType<typeof thrownObservation>;
    installOwnDescriptor(Object.prototype, field, {
      configurable: true,
      set(this: object) {
        calls++;
        installOwnDescriptor(this, field, {
          configurable: true,
          enumerable: true,
          value: arbitrary,
        });
      },
    });
    try {
      result = thrownObservation(error, "import");
      original = caught(invoke);
    } finally {
      restorePrototypeField(field, saved);
    }
    expect(original).toBe(error);
    expect(calls).toBe(0);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(typeof result[field]).toBe("string");
    expect(events.at(-1)).toMatchObject({
      gpuImport: { exception: { [field]: expect.any(String) } },
    });
    expect(JSON.stringify(events)).not.toContain("not a scalar");
  });
