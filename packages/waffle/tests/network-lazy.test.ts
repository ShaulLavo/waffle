import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

test("no module compilation before network(), and exactly one instance belongs to each runtime", () => {
  const root = new URL("../index.ts", import.meta.url).href;
  const ring = new URL("../browser/net/ring.ts", import.meta.url).href;
  const moduleURL = new URL("../browser/net/module.ts", import.meta.url).href;
  const worker = new URL("../browser/fs-worker.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    let compiled = 0, instances = 0, loads = 0, disposals = 0;
    const { loadNetworkModule: originalLoad } = await import(${JSON.stringify(moduleURL)});
    function observeInstance(instance) {
      return { ...instance, dispose() { disposals++; instance.dispose(); } };
    }
    async function observedLoad(...args) {
      loads++;
      const loaded = await originalLoad(...args);
      return { create: (...args) => observeInstance(loaded.create(...args)) };
    }
    mock.module(${JSON.stringify(moduleURL)}, () => ({ loadNetworkModule: observedLoad }));
    const compile = WebAssembly.compile;
    const Instance = WebAssembly.Instance;
    WebAssembly.compile = (...args) => { compiled++; return compile(...args); };
    WebAssembly.Instance = class extends Instance { constructor(...args) { super(...args); instances++; } };
    const { createRuntime, declareSharedMemoryPlatform } = await import(${JSON.stringify(root)});
    const { createRing } = await import(${JSON.stringify(ring)});
    assert.equal(compiled, 0); assert.equal(instances, 0);
    for (let index = 0; index < 2; index++) {
      const runtime = createRuntime({ sharedMemory: declareSharedMemoryPlatform({ kind: "unbounded" }), filesystem: { mode: "memory", workerURL: new URL(${JSON.stringify(worker)}) } });
      try {
        await runtime.filesystem.listFiles("/");
        const unregisterAdapter = runtime.registerAdapter("unused", () => { throw Error("must stay inactive"); });
        const unregister = runtime.registerProgram("/unused", { adapter: "unused", source: new Uint8Array([0]) });
        unregister(); unregisterAdapter();
        await runtime.processes();
        assert.equal(loads, index ? 1 : 0);
        assert.equal(instances, index);
        assert.equal(compiled, index ? 1 : 0);
        const first = runtime.network();
        const second = runtime.network();
        assert.equal(first, second);
        const [network, concurrent] = await Promise.all([first, second]);
        assert.equal(network, concurrent);
        assert.equal(loads, 1);
        assert.equal(instances, index + 1);
        assert.equal(await runtime.network(), network);
        network.createHelper({ ring: createRing(), fetch: async () => { throw Error("external fetch"); } });
        network.createHelper({ ring: createRing(), fetch: async () => { throw Error("external fetch"); } });
        assert.equal(instances, index + 1);
      } finally { await runtime.dispose(); await runtime.dispose(); }
      assert.equal(disposals, index + 1);
    }
    assert.equal(compiled, 1);
    console.log("lazy network compile=1, instances=2, helpers=4, loads=1, disposals=2");
  `;
  const output = execFileSync(process.execPath, ["--eval", script], {
    encoding: "utf8",
    timeout: 10000,
  });
  expect(output).toContain("compile=1, instances=2, helpers=4");
});

for (const entry of ["../browser/net/host.ts", "./network-browser-worker.ts"]) {
  test(`${entry} excludes owner, helper, loader, native and WASM inputs from the guest graph`, async () => {
    const result = await Bun.build({
      entrypoints: [new URL(entry, import.meta.url).pathname],
      target: "browser",
      metafile: true,
    });
    expect(result.success).toBe(true);
    if (!result.metafile) throw new Error("missing guest graph");
    expect(
      Object.keys(result.metafile.inputs).filter((path) =>
        /browser\/net\/(?:module|namespace|runtime|helper)\.ts$|(?:^|\/)(?:network|native)\/|\.wasm$/.test(
          path,
        ),
      ),
    ).toEqual([]);
    expect(result.outputs.some((output) => output.path.endsWith(".wasm"))).toBe(false);
  });
}

test("disposal during a held module load creates no orphan instance", () => {
  const root = new URL("../index.ts", import.meta.url).href;
  const moduleURL = new URL("../browser/net/module.ts", import.meta.url).href;
  const worker = new URL("../browser/fs-worker.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    let instances = 0, disposals = 0;
    const { loadNetworkModule: originalLoad } = await import(${JSON.stringify(moduleURL)});
    mock.module(${JSON.stringify(moduleURL)}, () => ({ async loadNetworkModule() {
      started.resolve(); await release.promise;
      const compiled = await originalLoad();
      return { create(...args) {
        instances++;
        const instance = compiled.create(...args);
        return { ...instance, dispose() { disposals++; instance.dispose(); } };
      } };
    } }));
    const { createRuntime, declareSharedMemoryPlatform } = await import(${JSON.stringify(root)});
    const options = { filesystem: { mode: "memory", workerURL: new URL(${JSON.stringify(worker)}) } };
    const runtime = createRuntime({ sharedMemory: declareSharedMemoryPlatform({ kind: "unbounded" }), ...options });
    const outcome = runtime.network().then(() => "unexpected", error => error.message);
    await started.promise;
    const disposal = runtime.dispose();
    release.resolve();
    await disposal;
    assert.match(await outcome, /disposed/i);
    assert.equal(instances, 0); assert.equal(disposals, 0);
    const next = createRuntime({ sharedMemory: declareSharedMemoryPlatform({ kind: "unbounded" }), ...options });
    await next.network();
    assert.equal(instances, 1);
    await next.dispose(); await next.dispose();
    assert.equal(disposals, 1);
    console.log("pending activation instances=0; subsequent instances=1 disposals=1");
  `;
  expect(
    execFileSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10000 }),
  ).toContain("subsequent instances=1 disposals=1");
});

test("concurrent network imports finish before the explicit shared compilation starts", () => {
  const helperURL = new URL("../browser/net/helper.ts", import.meta.url).href;
  const runtimeURL = new URL("../browser/net/runtime.ts", import.meta.url).href;
  const moduleURL = new URL("../browser/net/module.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const { loadNetworkModule: originalLoad } = await import(${JSON.stringify(moduleURL)});
    const release = Promise.withResolvers();
    let imported = false, loads = 0, instances = 0;
    mock.module(${JSON.stringify(moduleURL)}, () => ({ async loadNetworkModule() {
      assert.equal(imported, true, "network compilation must not suspend module evaluation");
      loads++;
      await release.promise;
      const compiled = await originalLoad();
      return { create(...args) { instances++; return compiled.create(...args); } };
    } }));
    const [{ NetNamespace, NetHelper }, { createRuntimeNetwork }] = await Promise.all([
      import(${JSON.stringify(helperURL)}), import(${JSON.stringify(runtimeURL)}),
    ]);
    imported = true;
    assert.equal(loads, 0);
    assert.equal(typeof NetHelper, "function");
    const first = createRuntimeNetwork(() => {});
    const second = NetNamespace.create();
    assert.equal(loads, 1);
    assert.equal(instances, 0);
    release.resolve();
    const [owner, namespace] = await Promise.all([first, second]);
    try {
      assert.equal(loads, 1);
      assert.equal(instances, 2);
    } finally { await owner.dispose(); namespace.dispose(); }
    console.log("imports ready before compilation; shared loads=1, owned instances=2");
  `;
  expect(
    execFileSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10000 }),
  ).toContain("imports ready before compilation; shared loads=1, owned instances=2");
});

test("explicit namespace initialization preserves a shared loader failure without retrying", () => {
  const namespaceURL = new URL("../browser/net/namespace.ts", import.meta.url).href;
  const runtimeURL = new URL("../browser/net/runtime.ts", import.meta.url).href;
  const moduleURL = new URL("../browser/net/module.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    let loads = 0;
    const failure = new TypeError("network module is unsupported");
    mock.module(${JSON.stringify(moduleURL)}, () => ({ async loadNetworkModule() {
      loads++;
      throw failure;
    } }));
    const [{ NetNamespace }, { createRuntimeNetwork }] = await Promise.all([
      import(${JSON.stringify(namespaceURL)}), import(${JSON.stringify(runtimeURL)}),
    ]);
    assert.equal(loads, 0);
    await assert.rejects(createRuntimeNetwork(() => {}), error => error === failure);
    await assert.rejects(NetNamespace.create(), error => error === failure);
    assert.equal(loads, 1);
    console.log("original loader failure preserved; shared loads=1, no retry");
  `;
  expect(
    execFileSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10000 }),
  ).toContain("original loader failure preserved; shared loads=1, no retry");
});

for (const failure of ["undefined", "null", "false", "0", '""', "accessorError"]) {
  test(`genuine network loader rejection survives disposal by identity (${failure})`, () => {
    const root = new URL("../index.ts", import.meta.url).href;
    const moduleURL = new URL("../browser/net/module.ts", import.meta.url).href;
    const worker = new URL("../browser/fs-worker.ts", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import { mock } from "bun:test";
      const started = Promise.withResolvers(), release = Promise.withResolvers();
      let reads = 0, loads = 0;
      const accessorError = Object.defineProperties(new Error(), Object.fromEntries(
        ["name", "message", "code", "errno", "then"].map(name => [name, {
          get() { reads++; throw Error("loader error accessor must not run"); },
        }]),
      ));
      const failure = ${failure};
      mock.module(${JSON.stringify(moduleURL)}, () => ({ async loadNetworkModule() {
        loads++;
        started.resolve();
        await release.promise;
        throw failure;
      } }));
      const { createRuntime, declareSharedMemoryPlatform } = await import(${JSON.stringify(root)});
      const runtime = createRuntime({ sharedMemory: declareSharedMemoryPlatform({ kind: "unbounded" }), filesystem: { mode: "memory", workerURL: new URL(${JSON.stringify(worker)}) } });
      const outcome = runtime.network().then(() => ({ resolved: true }), reason => ({ resolved: false, reason }));
      await started.promise;
      const disposal = runtime.dispose().then(() => ({ resolved: true }), reason => ({ resolved: false, reason }));
      release.resolve();
      const result = await outcome, stopped = await disposal;
      assert.equal(result.resolved, false);
      assert.equal(stopped.resolved, false);
      assert.equal(result.reason, failure);
      assert.equal(stopped.reason, failure);
      assert.equal(loads, 1);
      assert.equal(reads, 0);
      console.log("loader rejection preserved by identity during disposal; accessor reads=0");
    `;
    expect(
      execFileSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10000 }),
    ).toContain("loader rejection preserved by identity during disposal; accessor reads=0");
  });
}
