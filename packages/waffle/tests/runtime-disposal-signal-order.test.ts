import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

for (const mode of ["consumer", "display"])
  test(`Runtime publishes process signals before ${mode} revocation`, () => {
    const script = new URL("./fixtures/gpu/runtime-disposal-signal-order.ts", import.meta.url);
    const output = execFileSync(process.execPath, [script.pathname, mode], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const result: unknown = JSON.parse(output);
    expect(result).toEqual({
      consumerSignal: 9,
      displaySignal: 9,
      controllerSignal: 9,
      physicalStopsBeforeFence: 0,
      physicalStopsAfterFence: 1,
      serviceStops: 1,
      workerJoined: true,
      returns: 0,
      nextImport: 0,
      authenticatedSignal: 9,
      closedBytes: 0,
    });
  });
