import { startPage, type HostPageRun } from "waffle/testing/page-runner/page";
import { gpuAsyncCapabilities, gpuAsyncInvoke, gpuAsyncTeardown } from "./gpu-async-operations.js";
import { gpuAsyncId, type GpuAsyncRequest } from "./gpu-async-request.js";

const run: HostPageRun<GpuAsyncRequest> = {
  kind: "host",
  teardown: () => gpuAsyncTeardown(),
};
window.__gpuAsync = { capabilities: gpuAsyncCapabilities, invoke: gpuAsyncInvoke, value: null };
startPage<GpuAsyncRequest>({
  list: async () => ({ ids: [gpuAsyncId] }),
  run,
  finish: async (ledger) => ledger.slice(),
});
