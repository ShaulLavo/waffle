import { FilesystemClient } from "@waffle-os/runtime/fs";
import type { Runtime } from "@waffle-os/runtime";
import { startCommand, type CommandOptions } from "@waffle-os/runtime/command";
import assert from "../test-assert.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const path = (name: string) => "/test/" + name;

async function register(runtime: Runtime, name: string) {
  await runtime.filesystem.writeFile(path(name), "");
  runtime.registerProgram(path(name), {
    adapter: "command-controls",
    source: async () => new Uint8Array(await (await fetch("/fixtures/" + name)).arrayBuffer()),
  });
}

function expectExit(result: Awaited<ReturnType<typeof startCommand>["result"]>, code = 0) {
  assert.deepEqual(result.exit, { kind: "exited", code, status: code });
}

function run(runtime: Runtime, name: string, options: Omit<CommandOptions, "filesystem"> = {}) {
  return startCommand(runtime, path(name), { filesystem: "runtime-root", ...options });
}

async function output(runtime: Runtime) {
  const payload = "input to both streams\n".repeat(20_000);
  let delivered = "";
  let stderr = "";
  let remaining = payload;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!remaining) return controller.close();
      controller.enqueue(encoder.encode(remaining.slice(0, 32768)));
      remaining = remaining.slice(32768);
    },
  });
  const completed = await run(runtime, "tee", {
    stdin: source,
    stdout: {
      limitBytes: 123,
      onChunk: (chunk) => {
        delivered += decoder.decode(chunk);
        chunk.fill(0);
      },
    },
    stderr: {
      limitBytes: 0,
      onChunk: (chunk) => {
        stderr += decoder.decode(chunk);
      },
    },
  }).result;
  expectExit(completed);
  assert.equal(decoder.decode(completed.stdout.bytes), payload.slice(0, 123));
  assert.equal(completed.stdout.truncated, true);
  assert.equal(delivered, payload);
  assert.equal(stderr, payload);
  assert.equal(completed.stderr.bytes.length, 0);
  assert.equal(completed.stderr.truncated, true);
  const omitted = await run(runtime, "tee").result;
  expectExit(omitted);
  assert.equal(omitted.stdout.bytes.length, 0);
  const closed = await run(runtime, "closed-output", { stdout: "closed" }).result;
  expectExit(closed);
  assert.equal(closed.stdout.bytes.length, 0);
  assert.equal(closed.stdout.truncated, false);
  assert.equal(decoder.decode(closed.stderr.bytes), "stderr");
}

async function inputStop(runtime: Runtime) {
  const requested = Promise.withResolvers<void>();
  const never = Promise.withResolvers<void>();
  const source = new ReadableStream<Uint8Array>({
    pull: () => never.promise,
    cancel() {
      requested.resolve();
      return never.promise;
    },
  });
  let alive = true;
  const command = run(runtime, "close-input", { stdin: source });
  void command.result.finally(() => {
    alive = false;
  });
  await requested.promise;
  assert.equal(source.locked, false);
  assert.equal(alive, true);
  const joined = command.kill();
  assert.equal(joined, command.result);
  assert.deepEqual((await joined).exit, { kind: "signaled", code: 9, status: 137 });
}

async function signals(runtime: Runtime) {
  expectExit(await run(runtime, "exit130").result, 130);
  const ready = Promise.withResolvers<void>();
  const handled = Promise.withResolvers<void>();
  let output = "";
  const command = run(runtime, "sigint-twice", {
    stdout: {
      onChunk: (chunk) => {
        output += decoder.decode(chunk);
        if (output.includes("ready")) ready.resolve();
        if (output.includes("handled")) handled.resolve();
      },
    },
  });
  await ready.promise;
  await command.signal(2);
  await handled.promise;
  await command.signal(2);
  assert.deepEqual((await command.result).exit, { kind: "signaled", code: 2, status: 130 });
  assert.equal(output, "readyhandled");
  const cancelled = run(runtime, "exit130");
  assert.equal(cancelled.kill(), cancelled.result);
  assert.equal((await cancelled.result).exit, null);
  assert.equal((await cancelled.result).stopRequested, "kill");
}

async function rejectIO(runtime: Runtime) {
  const callbackError = new Error("command output callback failed");
  let callbacks = 0;
  const output = run(runtime, "tee", {
    stdin: encoder.encode("output past zero capture"),
    stdout: {
      limitBytes: 0,
      onChunk: () => {
        callbacks++;
        throw callbackError;
      },
    },
  });
  assert.equal(await output.result.catch((error) => error), callbackError);
  assert.equal(callbacks, 1);
  const inputError = new Error("command input failed");
  const source = new ReadableStream<Uint8Array>({
    pull: () => {
      throw inputError;
    },
  });
  assert.equal(
    await run(runtime, "tee", { stdin: source }).result.catch((error) => error),
    inputError,
  );
  assert.equal(source.locked, false);
}

async function deadline(runtime: Runtime) {
  const command = run(runtime, "close-input", { stdin: new Uint8Array(0), deadlineMs: 1000 });
  const disposition = await command.result;
  assert.equal(command.kill(), command.result);
  assert.equal(disposition.stopRequested, "deadline");
  assert.deepEqual(disposition.exit, { kind: "signaled", code: 9, status: 137 });
  expectExit(await run(runtime, "exit130").result, 130);
}

async function alias(runtime: Runtime) {
  const connection = runtime.filesystem.fork();
  const client = new FilesystemClient(connection);
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const link = await client.asyncCall("resolve", [root, "test/host-alias", false]);
    await client.asyncCall("symlink", [link, path("host")]);
  } finally {
    client.dispose();
    await runtime.filesystem.quiesce(connection);
  }
}

async function admission(runtime: Runtime) {
  let forbidden = 0;
  runtime.registerHostAdapter("forbidden", () => {
    forbidden++;
    throw Error("entered host adapter");
  });
  await runtime.filesystem.writeFile(path("script"), "#!/test/exit130");
  runtime.registerProgram(path("script"), {
    adapter: "command-controls",
    script: {
      interpreter: path("exit130"),
      prepare: async () => {
        forbidden++;
      },
    },
  });
  await runtime.filesystem.writeFile(path("shebang"), "#!/test/exit130");
  await runtime.filesystem.writeFile(path("host"), "");
  runtime.registerProgram(path("host"), {
    adapter: "forbidden",
    source: () => {
      forbidden++;
      return new Uint8Array(0);
    },
  });
  await alias(runtime);
  await runtime.filesystem.writeFile(path("broken"), "");
  runtime.registerProgram(path("broken"), {
    adapter: "command-controls",
    source: new Uint8Array([0, 1, 2]),
  });
  await runtime.filesystem.writeFile(path("opaque"), "");
  runtime.registerProgram(path("opaque"), {
    adapter: "command-controls",
    cooperative: true,
    module: () => {
      forbidden++;
      throw new Error("opaque module loaded");
    },
  });
  for (const [name, error] of [
    ["missing", "ENOENT"],
    ["broken", "ENOEXEC"],
    ["opaque", "EACCES"],
    ["script", "EACCES"],
    ["shebang", "EACCES"],
    ["host-alias", "EACCES"],
  ]) {
    const { exit } = await run(runtime, name!).result;
    assert.ok(exit?.kind === "start-failed", name);
    assert.equal(exit.error, error, name);
  }
  expectExit(await run(runtime, "spawn-disallowed").result);
  expectExit(await run(runtime, "exec-disallowed").result);
  expectExit(await run(runtime, "exec-child").result, 130);
  assert.equal(forbidden, 0);
}

export async function controls(runtime: Runtime) {
  await runtime.filesystem.mkdirp("/test");
  for (const name of [
    "tee",
    "closed-output",
    "close-input",
    "exit130",
    "sigint-twice",
    "spawn-child",
    "spawn-disallowed",
    "exec-disallowed",
    "exec-child",
  ])
    await register(runtime, name);
  await output(runtime);
  await inputStop(runtime);
  await signals(runtime);
  await rejectIO(runtime);
  await deadline(runtime);
  await admission(runtime);
  expectExit(await run(runtime, "spawn-child").result);
  return repeat(runtime);
}

async function repeat(runtime: Runtime) {
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const counts = () => ({
    workers: service.workerMemory().length,
    processes: Array.from(supervisor.table.values()).length,
    jobs: Array.from(supervisor.table.jobValues()).length,
    liveTickets: runtime.sharedMemory
      .snapshot()
      .holders.filter(
        (holder) =>
          (holder.scope === "ticket" || holder.scope === "worker") && holder.state === "live",
      ).length,
  });
  const before = counts();
  const debtBefore = runtime.sharedMemory.snapshot().debtBytes;
  assert.deepEqual(before, { workers: 0, processes: 0, jobs: 0, liveTickets: 0 });
  for (let repeat = 0; repeat < 3; repeat++) {
    const cases = [`batch ${repeat} left`, `batch ${repeat} right`];
    const results = await Promise.all(
      cases.map((value) => run(runtime, "tee", { stdin: encoder.encode(value) }).result),
    );
    results.forEach((result, index) => {
      expectExit(result);
      assert.equal(decoder.decode(result.stdout.bytes), cases[index]);
    });
    assert.deepEqual(counts(), before);
  }
  const { holders, debtBytes, reservedBytes } = runtime.sharedMemory.snapshot();
  return {
    live: counts(),
    debtBytes,
    repeatedRunDebtBytes: debtBytes - debtBefore,
    reservedBytes,
    registryMaxBytes: Math.max(
      0,
      ...holders
        .filter((holder) => holder.label === "pipe-registry")
        .map((holder) => holder.declaredBytes),
    ),
  };
}
