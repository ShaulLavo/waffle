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

test("guest network hosts do not load the namespace module or WASM loader", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../browser/net/host.ts", import.meta.url).pathname],
    target: "browser",
    metafile: true,
  });
  expect(result.success).toBe(true);
  expect(
    Object.keys(result.metafile!.inputs).filter((path) =>
      /browser\/net\/(?:module|namespace)\.ts$/.test(path),
    ),
  ).toEqual([]);
});
