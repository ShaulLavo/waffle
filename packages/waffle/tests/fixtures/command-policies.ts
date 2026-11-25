import assert from "node:assert/strict";
import { startCommand, type CommandOptions } from "../../proc/start-command.js";
import { createRuntime, type ProgramDefinition } from "../../runtime.js";
import { compileCommandGuests } from "./command-guests.js";

const runtime = createRuntime({
  filesystem: { mode: "memory", workerURL: new URL("../../browser/fs-worker.ts", import.meta.url) },
});
const workerUrl = new URL("../../browser/preview1-worker.ts", import.meta.url).href;
const guests = await compileCommandGuests();
const root = { filesystem: "runtime-root" } as const;

function source(name: string): Uint8Array {
  const bytes = guests.get(name);
  assert.ok(bytes, `Missing ${name} fixture`);
  return bytes;
}

function cooperative(name: string): ProgramDefinition {
  const module = new WebAssembly.Module(new Uint8Array(source(name)));
  return { adapter: "generic", module, cooperative: true };
}

async function install(path: string, program: ProgramDefinition) {
  runtime.registerProgram(path, program);
  await runtime.filesystem.writeFile(path, "");
}

async function exitOf(path: string, options: Partial<CommandOptions> = {}) {
  return (await startCommand(runtime, path, { ...root, ...options }).result).exit;
}

async function echoesThroughCooperativeModule() {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  const echoed = Promise.withResolvers<string>();
  const command = startCommand(runtime, "/test/tee", {
    ...root,
    programs: "guest",
    stdin: input.readable,
    stdout: {
      limitBytes: 0,
      onChunk(bytes) {
        echoed.resolve(new TextDecoder().decode(bytes));
      },
    },
    stderr: { limitBytes: 0 },
  });
  await writer.write(new TextEncoder().encode("ping"));
  assert.equal(await echoed.promise, "ping");
  await writer.close();
  assert.deepEqual((await command.result).exit, { kind: "exited", code: 0, status: 0 });
}

/**
 * Starts the leader with two independent signals. `descendantRunning` resolves when the child
 * writes. `leaderGone` resolves when stdin is cancelled: only the leader holds the pipe's read
 * end (the child does not inherit fd 0), so the reader hangup that cancels it means the leader
 * has exited and released its descriptors.
 */
function startLeader(options: Partial<CommandOptions>) {
  const descendantRunning = Promise.withResolvers<void>();
  const leaderGone = Promise.withResolvers<void>();
  const command = startCommand(runtime, "/test/leader", {
    ...root,
    ...options,
    stdin: new ReadableStream<Uint8Array>({ cancel: () => leaderGone.resolve() }),
    stdout: {
      onChunk() {
        descendantRunning.resolve();
      },
    },
  });
  return { command, descendantRunning: descendantRunning.promise, leaderGone: leaderGone.promise };
}

try {
  runtime.registerAdapter("generic", (context, service) =>
    service.launchWorker(context, {
      workerUrl,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    }),
  );
  await runtime.filesystem.mkdirp("/test");
  await install("/test/tee", cooperative("tee"));
  await install("/test/exit130", cooperative("exit130"));
  await install("/test/exec-child", cooperative("exec-child"));
  await install("/test/host", { command: { load: async () => async () => 0 } });
  await install("/test/live", { adapter: "generic", source: source("live") });
  await install("/test/leader", { adapter: "generic", source: source("leader-exit7") });

  assert.equal((await exitOf("/test/tee"))?.kind, "start-failed");
  await echoesThroughCooperativeModule();
  assert.deepEqual(await exitOf("/test/exec-child", { programs: "guest" }), {
    kind: "exited",
    code: 130,
    status: 130,
  });
  assert.equal((await exitOf("/test/host", { programs: "guest" }))?.kind, "start-failed");

  const joined = startLeader({});
  await Promise.all([joined.descendantRunning, joined.leaderGone]);
  const killed = await joined.command.kill();
  assert.deepEqual(killed.exit, { kind: "exited", code: 7, status: 7 });
  assert.equal(killed.stopRequested, "kill");

  const stopped = startLeader({ onLeaderExit: "stop" });
  const result = await stopped.command.result;
  assert.deepEqual(result.exit, { kind: "exited", code: 7, status: 7 });
  assert.equal(result.stopRequested, undefined);
} finally {
  await runtime.dispose();
}
