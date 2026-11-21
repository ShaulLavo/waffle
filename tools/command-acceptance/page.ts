import { controls } from "./controls.ts";
import { createRuntime, type Runtime, type GuestLauncher } from "@waffle-os/runtime";
import { startCommand } from "@waffle-os/runtime/command";
import { bytes, declareSharedMemoryPlatform } from "@waffle-os/runtime/memory";
import { coreutils } from "@waffle-os/coreutils";

const launcher: GuestLauncher = (context, service) =>
  service.launchWorker(context, {
    workerUrl: "/preview1-worker.js",
    request: {
      module: context.module,
      args: context.request.argv,
      env: context.request.env,
      interruptible: context.interruptible,
    },
  });
const runtime = createRuntime({
  filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
  programs: { launcher },
  sharedMemory: declareSharedMemoryPlatform({
    kind: "bounded",
    budgetBytes: bytes(2 * 1024 * 1024 * 1024),
    counts: { fixedBuffer: true, sharedMemory: true, privateMemory: true },
  }),
});

async function copyLine(runtime: Runtime): Promise<string> {
  await runtime.programs.onDemand(coreutils.pick("cat"));
  const command = startCommand(runtime, "/usr/bin/cat", {
    filesystem: "runtime-root",
    stdin: new TextEncoder().encode("hello from cat\n"),
    deadlineMs: 10_000,
  });
  const { exit, stdout } = await command.result;
  if (exit?.kind !== "exited" || exit.code !== 0 || stdout.truncated)
    throw new Error(`cat did not copy the full line: ${JSON.stringify(exit)}`);
  return new TextDecoder().decode(stdout.bytes);
}

try {
  const line = await copyLine(runtime);
  if (line !== "hello from cat\n") throw new Error(`Unexpected cat output: ${line}`);
  runtime.registerAdapter("command-controls", launcher);
  const counts = await controls(runtime);
  document.body.textContent = JSON.stringify({ ok: true, line, counts });
} catch (error) {
  document.body.textContent = JSON.stringify({
    ok: false,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
} finally {
  await runtime.dispose();
}
document.body.dataset.done = "true";
