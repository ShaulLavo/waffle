import { expect, test } from "bun:test";
import { checkNetworkBudget, NETWORK_BUDGET, networkSize } from "../tooling/network-size.js";

test("network WASM and loader have separate enforceable budgets", async () => {
  const size = await networkSize();
  expect(size.wasm).toBeGreaterThan(0);
  expect(size.wasmGzip).toBeLessThan(size.wasm);
  for (const name of ["wasm", "wasmGzip", "loaderGzip"] as const) {
    expect(() =>
      checkNetworkBudget({ ...NETWORK_BUDGET, [name]: NETWORK_BUDGET[name] + 1 }),
    ).toThrow(/network/);
  }
});
