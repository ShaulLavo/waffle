import type { LinkedWorkerRequest } from "../../link/worker.js";

const nativeCompile = WebAssembly.compile;
const nativeStreaming = WebAssembly.compileStreaming;
const NativeModule = WebAssembly.Module;
const NativeInstance = WebAssembly.Instance;
const calls = { compile: 0, streaming: 0, constructor: 0 };
const instances: WebAssembly.Instance[] = [];
WebAssembly.compile = (bytes) => {
  calls.compile++;
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer))
    throw new Error("expected private compiler bytes");
  return nativeCompile(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
};
WebAssembly.compileStreaming = (source) => {
  calls.streaming++;
  return nativeStreaming(source);
};
WebAssembly.Module = new Proxy(NativeModule, {
  construct(Target, args: ConstructorParameters<typeof WebAssembly.Module>) {
    calls.constructor++;
    return new Target(...args);
  },
});
WebAssembly.Instance = new Proxy(NativeInstance, {
  construct(Target, args: ConstructorParameters<typeof WebAssembly.Instance>) {
    const instance = new Target(...args);
    instances.push(instance);
    return instance;
  },
});

async function run(request: LinkedWorkerRequest): Promise<void> {
  const empty = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  await WebAssembly.compile(empty);
  await WebAssembly.compileStreaming(
    new Response(empty, { headers: { "Content-Type": "application/wasm" } }),
  );
  new WebAssembly.Module(empty);
  const control = { ...calls };
  if (Object.values(control).some((count) => count !== 1))
    throw new Error("compiler observer did not arm");
  calls.compile = calls.streaming = calls.constructor = 0;
  const { bootstrap } = await import("../../browser/worker.js");
  const { linkedWorkerHooks } = await import("../../link/index.js");
  const hooks = linkedWorkerHooks();
  let table: WebAssembly.Table | undefined;
  await bootstrap(request, {
    ...hooks,
    namespaces: () => ({ env: { check() {} } }),
    run(context) {
      const side = instances.find((instance) => typeof instance.exports.entry === "function");
      const entry = side?.exports.entry;
      if (typeof entry !== "function" || entry(7) !== 8)
        throw new Error("transported self relay failed");
      const exported = context.instance.exports.__indirect_function_table;
      if (!(exported instanceof WebAssembly.Table)) throw new Error("missing core table");
      table = exported;
      if (Object.values(calls).some((count) => count !== 0))
        throw new Error("worker recompiled the linked image");
      self.postMessage({ type: "relay-observation", control, calls, relay: 8 });
      return 8;
    },
    beforeFinish() {
      hooks.beforeFinish?.();
      if (!table) return;
      for (let index = 0; index < table.length; index++) {
        if (table.get(index) !== null) throw new Error("linked table resources survived cleanup");
      }
    },
  });
}

self.onmessage = ({ data }: MessageEvent<LinkedWorkerRequest>) =>
  void run(data).catch((error) => {
    self.postMessage({ type: "error", code: 1, message: String(error) });
  });
