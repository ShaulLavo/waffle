import { createRuntime, type Runtime } from "@waffle-os/runtime";
import { startCommand } from "@waffle-os/runtime/command";
import { coreutils } from "@waffle-os/coreutils";

const runtime = createRuntime({
  filesystem: { workerURL: "/fs-worker.js", mode: "memory" },
  programs: {
    launcher: (context, service) =>
      service.launchWorker(context, {
        workerUrl: "/preview1-worker.js",
        request: {
          module: context.module,
          args: context.request.argv,
          env: context.request.env,
          interruptible: context.interruptible,
        },
      }),
  },
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
  await runtime.dispose();
  document.body.textContent = JSON.stringify({ ok: true, line });
} catch (error) {
  document.body.textContent = JSON.stringify({
    ok: false,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
document.body.dataset.done = "true";
