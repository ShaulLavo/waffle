import assert from "node:assert/strict";
import { bytes, declareSharedMemoryPlatform } from "../../memory/reservations.js";
import { startCommand } from "../../proc/start-command.js";
import { createRuntime } from "../../runtime.js";
import { compileCommandGuests } from "./command-guests.js";

const runtime = createRuntime({
  filesystem: { mode: "memory", workerURL: new URL("../../browser/fs-worker.ts", import.meta.url) },
  sharedMemory: declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(1780 * 1024 * 1024),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  }),
});
const workerUrl = new URL("../../browser/preview1-worker.ts", import.meta.url).href;
try {
  const source = (await compileCommandGuests()).get("exit130");
  assert.ok(source, "Missing exit fixture");
  runtime.registerAdapter("generic", (context, service) =>
    service.launchWorker(context, {
      workerUrl,
      request: { module: context.module, args: context.request.argv, env: context.request.env },
    }),
  );
  runtime.registerProgram("/fixture", { adapter: "generic", source });
  await runtime.filesystem.writeFile("/fixture", "");
  const result = await startCommand(runtime, "/fixture", { filesystem: "runtime-root" }).result;
  assert.deepEqual(result.exit, { kind: "exited", code: 130, status: 130 });
} finally {
  await runtime.dispose();
}
