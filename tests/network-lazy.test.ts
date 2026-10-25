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
    const { createRuntime } = await import(${JSON.stringify(root)});
    const { createRing } = await import(${JSON.stringify(ring)});
    assert.equal(compiled, 0); assert.equal(instances, 0);
    for (let index = 0; index < 2; index++) {
      const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL(${JSON.stringify(worker)}) } });
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
    const { createRuntime } = await import(${JSON.stringify(root)});
    const options = { filesystem: { mode: "memory", workerURL: new URL(${JSON.stringify(worker)}) } };
    const runtime = createRuntime(options);
    const outcome = runtime.network().then(() => "unexpected", error => error.message);
    await started.promise;
    const disposal = runtime.dispose();
    release.resolve();
    await disposal;
    assert.match(await outcome, /disposed/i);
    assert.equal(instances, 0); assert.equal(disposals, 0);
    const next = createRuntime(options);
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
