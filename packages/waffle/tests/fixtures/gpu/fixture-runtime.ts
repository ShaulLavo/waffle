import { createRuntime } from "../../../runtime.js";
import { BrowserProcessBroker } from "../../../browser/process-broker.js";
import type { GraphicsGrant } from "../../../browser/display/protocol.js";
import { bytes, declareSharedMemoryPlatform } from "../../../memory/index.js";
import type { DescriptorTable } from "../../../core/descriptors.js";
import { RIGHTS_ALL } from "../../../core/rights.js";
import { PipeController } from "../../../proc/pipes.js";

export function createGpuFixtureRuntime(
  grant: () => GraphicsGrant | undefined,
  onError: (error: unknown) => void,
) {
  const runtime = createRuntime({
    sharedMemory: declareSharedMemoryPlatform({
      kind: "bounded",
      budgetBytes: bytes(3 * 1024 ** 3),
      counts: { fixedBuffer: true, sharedMemory: true, privateMemory: false },
    }),
    filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
    processHost: (options) => new BrowserProcessBroker({ ...options, onError }),
  });
  runtime.registerAdapter("gpu", (context, service) =>
    service.launchWorker(context, {
      workerUrl: "/gpu-guest.js",
      graphics: grant(),
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    }),
  );
  return runtime;
}
export function gpuFixturePipes(descriptors: DescriptorTable, rootPid: number) {
  const stdout = new PipeController({ relay: "manual" }),
    stdin = new PipeController({ relay: "manual" });
  const input = stdin.retain(rootPid, "write"),
    output = stdout.retain(rootPid, "read");
  descriptors.close(0);
  descriptors.close(1);
  descriptors.close(2);
  descriptors.openAt(0, stdin.retain(rootPid, "read"), RIGHTS_ALL, RIGHTS_ALL);
  descriptors.openAt(1, stdout.retain(rootPid, "write"), RIGHTS_ALL, RIGHTS_ALL);
  descriptors.openAt(2, stdout.retain(rootPid, "write"), RIGHTS_ALL, RIGHTS_ALL);
  return { input, output };
}
