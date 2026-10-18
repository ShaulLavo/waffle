/** Test-owned natives, captured independently of Waffle before guest code runs. */
const nativeApply = Reflect.apply;
const nativeConstruct = Reflect.construct;
const nativeOwnKeys = Reflect.ownKeys;
const nativeDescriptor = Object.getOwnPropertyDescriptor;
const nativeDefine = Object.defineProperty;
const nativeDelete = Reflect.deleteProperty;
const nativePostMessage = globalThis.postMessage;
const nativePrototype = Object.getPrototypeOf;
const nativeIsView = ArrayBuffer.isView;
const NativeSharedArrayBuffer = SharedArrayBuffer;
const NativeInt32Array = Int32Array;
const NativeDataView = DataView;
const NativeSet = Set,
  NativeMap = Map;
const nativeSetHas = Set.prototype.has,
  nativeSetAdd = Set.prototype.add;
const nativeMapForEach = Map.prototype.forEach,
  nativeSetForEach = Set.prototype.forEach;
const generatorPrototype = nativePrototype(nativePrototype((function* () {})()));
const typedPrototype = nativePrototype(Int32Array.prototype);
const typedBuffer = nativeDescriptor(typedPrototype, "buffer")!.get!;
const dataViewBuffer = nativeDescriptor(DataView.prototype, "buffer")!.get!;

export interface IntrinsicsReport {
  replacements: string[];
  canaries: string[];
  leaks: string[];
}

function restoreProperty(
  owner: object,
  key: PropertyKey,
  original: PropertyDescriptor | undefined,
): void {
  if (!original) {
    nativeDelete(owner, key);
    return;
  }
  const restored = { __proto__: null, ...original };
  nativeDefine(owner, key, restored);
}

function observedPostMessage(
  observe: (name: string, receiver: unknown, args: readonly unknown[]) => void,
): Function {
  return function (this: unknown, ...args: unknown[]) {
    observe("postMessage", undefined, args);
    return nativeApply(nativePostMessage, this, args);
  };
}

function inheritedField(
  name: string,
  inspect: (name: string, value: unknown) => void,
): PropertyDescriptor {
  return {
    configurable: true,
    get: function (this: unknown) {
      inspect(name, this);
      return undefined;
    },
  };
}

/** Transparent guest replacements: record exposure, but preserve native behavior so
 * an authority failure cannot be mistaken for a deliberately broken test stub.
 * Only the process directory/identity buffers are private process state; unrelated
 * filesystem and canary SABs must not turn this into an all-runtime hardening test. */
export function poisonProcessIntrinsics(buffers: readonly SharedArrayBuffer[]): {
  restore(): IntrinsicsReport;
} {
  const privateBuffers = new NativeSet(buffers);
  const canary = new NativeSharedArrayBuffer(16);
  const canaryView = new NativeInt32Array(canary);
  const replacements: string[] = [],
    leaks: string[] = [];
  const canaries = new NativeSet<string>();
  const undo: (() => void)[] = [];
  const inspect = (name: string, value: unknown, depth = 0, seen = new NativeSet<object>()) => {
    let buffer: unknown = value;
    if (nativeIsView(value)) {
      // Never ask a poisoned .buffer getter to implement the observer itself.
      try {
        buffer = nativeApply(typedBuffer, value, []);
      } catch {
        buffer = nativeApply(dataViewBuffer, value, []);
      }
    }
    if (buffer === canary) nativeApply(nativeSetAdd, canaries, [name]);
    if (nativeApply(nativeSetHas, privateBuffers, [buffer])) {
      let recorded = false;
      for (let index = 0; index < leaks.length; index++) if (leaks[index] === name) recorded = true;
      if (!recorded) leaks[leaks.length] = name;
      return;
    }
    // Collection methods can expose authority nested in records rather than the view
    // itself. Inspect only data properties: the observer must not invoke guest getters.
    if (
      depth >= 5 ||
      typeof value !== "object" ||
      value === null ||
      nativeIsView(value) ||
      nativeApply(nativeSetHas, seen, [value])
    )
      return;
    nativeApply(nativeSetAdd, seen, [value]);
    if (value instanceof NativeMap)
      nativeApply(nativeMapForEach, value, [
        (entry: unknown, key: unknown) => {
          inspect(name, key, depth + 1, seen);
          inspect(name, entry, depth + 1, seen);
        },
      ]);
    if (value instanceof NativeSet)
      nativeApply(nativeSetForEach, value, [
        (entry: unknown) => inspect(name, entry, depth + 1, seen),
      ]);
    const keys = nativeOwnKeys(value);
    for (let index = 0; index < keys.length; index++) {
      const descriptor = nativeDescriptor(value, keys[index]!);
      if (descriptor && "value" in descriptor) inspect(name, descriptor.value, depth + 1, seen);
    }
  };
  const observe = (name: string, receiver: unknown, args: readonly unknown[]) => {
    inspect(name, receiver);
    for (let index = 0; index < args.length; index++) inspect(name, args[index]);
  };
  const replace = (
    owner: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
    name: string,
  ) => {
    const original = nativeDescriptor(owner, key);
    const replacement = { __proto__: null, ...descriptor };
    nativeDefine(owner, key, replacement);
    undo[undo.length] = () => restoreProperty(owner, key, original);
    replacements[replacements.length] = name;
  };
  const methods = (owner: object, family: string, getters = false) => {
    for (const key of nativeOwnKeys(owner)) {
      if (key === "constructor") continue;
      const descriptor = nativeDescriptor(owner, key)!;
      const name = `${family}.${String(key)}`;
      if (typeof descriptor.value === "function") {
        const method = descriptor.value;
        replace(
          owner,
          key,
          {
            ...descriptor,
            value: function (this: unknown, ...args: unknown[]) {
              observe(name, this, args);
              const result = nativeApply(method, this, args);
              inspect(name, result);
              return result;
            },
          },
          name,
        );
      } else if (getters && descriptor.get) {
        const getter = descriptor.get;
        replace(
          owner,
          key,
          {
            ...descriptor,
            get: function (this: unknown) {
              observe(name, this, []);
              return nativeApply(getter, this, []);
            },
          },
          name,
        );
      }
    }
  };
  try {
    methods(Atomics, "Atomics");
    methods(typedPrototype, "TypedArray", true);
    methods(NativeDataView.prototype, "DataView", true);
    // Replace both global constructors and each native prototype's constructor:
    // native subarray/slice can otherwise reach guest @@species via .constructor.
    for (const name of [
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float16Array",
      "Float32Array",
      "Float64Array",
      "BigInt64Array",
      "BigUint64Array",
      "DataView",
    ]) {
      const descriptor = nativeDescriptor(globalThis, name);
      if (!descriptor) continue; // Float16Array is not implemented by every test engine yet.
      const constructor = descriptor.value as Function;
      const replacement = new Proxy(constructor, {
        construct(target, args, newTarget) {
          observe(name, undefined, args);
          return nativeConstruct(target, args, newTarget);
        },
        apply(target, receiver, args) {
          observe(name, receiver, args);
          return nativeApply(target, receiver, args);
        },
      });
      replace(globalThis, name, { ...descriptor, value: replacement }, name);
      const prototypeConstructor = nativeDescriptor(constructor.prototype, "constructor")!;
      replace(
        constructor.prototype,
        "constructor",
        { ...prototypeConstructor, value: replacement },
        `${name}.prototype.constructor`,
      );
    }
    methods(Reflect, "Reflect");
    methods(Object, "Object");
    methods(Array, "Array");
    methods(NativeMap.prototype, "Map", true);
    methods(NativeSet.prototype, "Set", true);
    methods(generatorPrototype, "Generator");
    for (const key of ["call", "apply", "bind"] as const) {
      const descriptor = nativeDescriptor(Function.prototype, key)!;
      const method = descriptor.value as Function;
      replace(
        Function.prototype,
        key,
        {
          ...descriptor,
          value: function (this: unknown, ...args: unknown[]) {
            observe(`Function.${key}`, this, args);
            return nativeApply(method, this, args);
          },
        },
        `Function.${key}`,
      );
    }
    const proxyDescriptor = nativeDescriptor(globalThis, "Proxy")!;
    replace(
      globalThis,
      "Proxy",
      {
        ...proxyDescriptor,
        value: new Proxy(Proxy, {
          construct(target, args, newTarget) {
            observe("Proxy", undefined, args);
            return nativeConstruct(target, args, newTarget);
          },
        }),
      },
      "Proxy",
    );
    // Avoid changing unrelated array algorithms. These are the collection paths
    // which can otherwise hand nested private process records to guest code.
    for (const key of ["filter", "map", Symbol.iterator] as const) {
      const descriptor = nativeDescriptor(Array.prototype, key)!;
      const method = descriptor.value as Function;
      const name = `Array.${String(key)}`;
      replace(
        Array.prototype,
        key,
        {
          ...descriptor,
          value: function (this: unknown, ...args: unknown[]) {
            observe(name, this, args);
            return nativeApply(method, this, args);
          },
        },
        name,
      );
    }

    if (typeof nativePostMessage === "function") {
      replace(
        globalThis,
        "postMessage",
        { configurable: true, writable: true, value: observedPostMessage(observe) },
        "postMessage",
      );
      globalThis.postMessage({ type: "intrinsics-canary", buffer: canary });
    }
    replace(
      crypto,
      "randomUUID",
      { configurable: true, writable: true, value: () => "00000000-0000-4000-8000-000000000000" },
      "crypto.randomUUID",
    );
    if (crypto.randomUUID() === "00000000-0000-4000-8000-000000000000")
      nativeApply(nativeSetAdd, canaries, ["crypto.randomUUID"]);

    // Positive controls use guest-visible replacements, not the captured natives.
    // Assert each exposure observer is live even if Waffle correctly never calls it.
    Atomics.load(canaryView, 0);
    Atomics.compareExchange(canaryView, 0, 0, 0);
    new Int32Array(canary);
    canaryView.set([0]);
    canaryView.subarray(0, 1);
    void canaryView.buffer;
    void canaryView.byteOffset;
    void canaryView.byteLength;
    void canaryView.length;
    const data = new DataView(canary);
    data.getInt32(0);
    void data.buffer;
    void data.byteOffset;
    void data.byteLength;
    Reflect.get(canaryView, "0");
    Object.getOwnPropertyDescriptor(canaryView, "0");
    const records = [{ signals: { outcome: { cells: canaryView } } }];
    Array.from(records);
    records.filter(() => true);
    records.map((record) => record);
    for (const record of records) {
      void record; // Exercise the guest-visible iterator.
    }
    const map = new NativeMap();
    map.set(0, canaryView);
    map.get(0);
    const set = new NativeSet();
    set.add(canaryView);
    set.has(canaryView);
    const iterator = (function* () {
      yield canaryView;
    })();
    iterator.next();
    const noop = function () {};
    noop.call(canaryView);
    noop.apply(canaryView, []);
    noop.bind(canaryView);
    new Proxy(canaryView, {});
    // Native descriptor conversion performs inherited Get/HasProperty for omitted
    // fields. Install last so only the code under test and these canaries see it.
    for (const key of ["get", "set"] as const) {
      const name = `Object.prototype.${key}`;
      replace(Object.prototype, key, inheritedField(name, inspect), name);
    }
    const descriptorCanary = { value: canary } as PropertyDescriptor;
    void descriptorCanary.get;
    void descriptorCanary.set;
  } catch (error) {
    for (let index = undo.length - 1; index >= 0; index--) undo[index]!();
    throw error;
  }
  return {
    restore() {
      for (let index = undo.length - 1; index >= 0; index--) undo[index]!();
      return { replacements, canaries: Array.from(canaries), leaks };
    },
  };
}
