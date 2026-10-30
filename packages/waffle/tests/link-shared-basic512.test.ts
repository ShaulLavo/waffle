import { expect, test } from "bun:test";
import { MemoryGroups } from "../group/state.js";
import { PAGE_BYTES } from "../group/protocol.js";
import { prepareLinkPlan } from "../link/index.js";
import { sharedSource, verifiedInputs } from "./link-shared-basic512-fixture.js";

const directory = process.env.WAFFLE_SHARED_BASIC512_DIR;
interface Ready {
  readonly kind: "ready";
  readonly header: readonly number[];
  readonly coreBase: number;
  readonly coreSize: number;
  readonly slotPointer: number;
  readonly errnoPointer: number;
  readonly stackLow: number;
  readonly stackHigh: number;
  readonly stackPointer: number;
  readonly memoryBase: number;
  readonly memorySize: number;
  readonly ctorValue: number;
  readonly secondCtorValue: number;
  readonly unexpected: readonly string[];
}
function receive(worker: Worker): Promise<Ready> {
  return new Promise((resolve, reject) => {
    worker.onerror = reject;
    worker.onmessage = ({ data }) => {
      console.log("shared-pair phase", JSON.stringify(data));
      if (data.kind === "error") reject(new Error(data.message));
      if (data.kind === "ready") resolve(data);
    };
  });
}

test.skipIf(!directory)(
  "immutable shared basic512 pair initializes in two real members",
  async () => {
    const input = await verifiedInputs(directory!);
    console.log("originals-before", JSON.stringify(input.originals));
    const source = sharedSource(input.core, input.side);
    await prepareLinkPlan(source);
    await expect(
      prepareLinkPlan({
        ...source,
        core: {
          ...source.core,
          initializeMemory: [],
          initialize: ["core_initialize_memory", "__wasm_apply_data_relocs", "__wasm_call_ctors"],
        },
      }),
    ).rejects.toThrow("must be a memory stage");
    await expect(
      prepareLinkPlan({
        ...source,
        core: {
          ...source.core,
          initializeMemory: ["__wasm_apply_data_relocs", "core_initialize_memory"],
        },
      }),
    ).rejects.toThrow("cannot precede");
    const groups = new MemoryGroups({
      stackBytes: 8 * 1024 ** 2,
      maximumPages: 8192,
      budgetBytes: 512 * 1024 ** 2,
    });
    const firstLease = groups.admit(101, "shared-basic512-initialization", "new");
    const secondLease = groups.admit(102, "shared-basic512-initialization", firstLease.group);
    const entries = [firstLease, secondLease].map((lease) => ({
      lease,
      worker: new Worker(new URL("./link-quickjs-worker.ts", import.meta.url).href),
    }));
    try {
      const observed: Ready[] = [];
      for (const entry of entries) {
        const response = receive(entry.worker);
        const launched = entry.lease.launch();
        entry.worker.postMessage(
          { kind: "launch", directory, request: launched.request },
          launched.transfer,
        );
        observed.push(await response);
      }
      const [a, b] = observed;
      for (const value of observed) {
        expect(value.header).toEqual([2, 18]);
        expect(value.stackHigh - value.stackLow).toBe(8 * 1024 ** 2);
        expect(value.stackPointer).toBe(value.stackHigh);
        expect(value.slotPointer).toBeGreaterThanOrEqual(value.coreBase);
        expect(value.slotPointer + 8).toBeLessThanOrEqual(value.coreBase + value.coreSize);
        expect(value.errnoPointer).toBeGreaterThanOrEqual(value.coreBase);
        expect(value.errnoPointer).toBeLessThan(value.coreBase + value.coreSize);
        expect(value.ctorValue).toBe(value.secondCtorValue);
        expect(value.unexpected).toEqual([]);
        expect(value.memoryBase + value.memorySize).toBeLessThanOrEqual(
          firstLease.group.buffer().byteLength,
        );
      }
      expect(b!.errnoPointer - a!.errnoPointer).toBe(b!.coreBase - a!.coreBase);
      expect(groups.budget.committed).toBeGreaterThan(PAGE_BYTES);
    } finally {
      for (const entry of entries) entry.worker.postMessage({ kind: "close" });
      for (const entry of entries) {
        await entry.worker.terminate();
        expect(groups.budget.committed).toBeGreaterThan(0);
        entry.lease.stopped();
      }
      expect(groups.snapshot()).toEqual([]);
      expect(groups.budget.committed).toBe(0);
      console.log("originals-after", JSON.stringify((await verifiedInputs(directory!)).originals));
      console.log(
        "physical-stop",
        JSON.stringify({ snapshot: groups.snapshot(), committed: groups.budget.committed }),
      );
    }
  },
  120000,
);
