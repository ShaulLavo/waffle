import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { instantiateLinkPlan, prepareLinkPlan } from "../link/index.js";

// Produced by the dedicated PIC lane. This gate consumes bytes, never builds them.
const directory = process.env.WAFFLE_LINK_QUICKJS_FIXTURE;
test.skipIf(!directory)(
  "real QuickJS emitted profile links and initializes relocated data once",
  async () => {
    const core = new Uint8Array(await Bun.file(`${directory}/core.wasm`).arrayBuffer());
    const engine = new Uint8Array(await Bun.file(`${directory}/engine.wasm`).arrayBuffer());
    expect(createHash("sha256").update(core).digest("hex")).toBe(
      "a5e4d88c4fbec859a606a9a414ec2ba3676fdb34eede1ac307bafea86f35b35a",
    );
    expect(createHash("sha256").update(engine).digest("hex")).toBe(
      "556ec7cb03e60ed37d2e7e085ba2f2907a71f1148900028be4f0f85533e45c09",
    );
    const plan = await prepareLinkPlan({
      core: {
        id: "core",
        source: core,
        cooperative: true,
        checkpoint: { module: "runtime_proc", name: "signal" },
        initialize: ["__wasm_call_ctors"],
      },
      libraries: [
        {
          id: "quickjs",
          source: engine,
          cooperative: true,
          checkpoint: { module: "env", name: "core_checkpoint" },
          initialize: [
            "quickjs_initialize_memory",
            "quickjs_apply_data_relocs",
            "quickjs_call_ctors",
          ],
        },
      ],
      reserve: "bun_core_alloc",
    });
    let polls = 0;
    const wasi = new Wasi({
      args: [],
      env: {},
      fs: new MemFS(),
      preopens: {},
      stdout() {},
      stderr() {},
      sleep() {},
      namespaces: {
        runtime_proc: {
          signal(signal: number, mode: number) {
            expect(signal).toBe(0);
            expect(mode).toBe(4);
            polls++;
            return 0;
          },
        },
      },
    });
    const group = instantiateLinkPlan(plan, { wasi, checkActive() {} });
    const call = (instance: WebAssembly.Instance, name: string) => {
      const fn = instance.exports[name];
      if (typeof fn !== "function") throw Error(`missing ${name}`);
      return fn();
    };
    try {
      const library = group.libraries[0]!;
      expect(library.instance.exports.__stack_pointer).toBe(group.entry.exports.__stack_pointer);
      expect(call(library.instance, "quickjs_ctor_value")).toBe(0);
      group.initialize();
      expect(call(library.instance, "quickjs_ctor_value")).toBe(42);
      group.initialize();
      expect(call(library.instance, "quickjs_ctor_value")).toBe(42);
      expect(call(group.entry, "core_clock_smoke")).toBe(1);
      expect(call(library.instance, "quickjs_link_smoke")).toBe(42);
      expect(polls).toBeGreaterThan(0);
    } finally {
      group.dispose();
      wasi.descriptors.dispose();
    }
  },
);
