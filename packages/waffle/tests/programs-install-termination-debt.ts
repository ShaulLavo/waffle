import assert from "node:assert/strict";
import { createRuntime, type GuestLauncher, type RuntimeProcessContext } from "../index.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { installPrograms, type ProgramPackage } from "../programs/index.js";
import { createProgramShell } from "./fixtures/program-shell.js";
import { wasiCat } from "./fixtures/wasi-cat.js";

const scenario = process.argv[2];
assert(scenario && /^(?:(sync|async)-(waiting|later|second)|success)$/.test(scenario));
const failure = new Error(`injected ${scenario} physical termination failure`);
const stopAttempted = Promise.withResolvers<void>();
const stopReported = Promise.withResolvers<unknown>();
const stopAllowed = Promise.withResolvers<void>();
const fenceReady = Promise.withResolvers<void>();
const contexts: RuntimeProcessContext[] = [];
const tables: Parameters<typeof createProgramShell>[1] = [];
let terminationCalls = 0;
let disposals = 0;
let drains = 0;

const runtime = createRuntime({
  filesystem: {
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  },
  processHost: (options) => new BrowserProcessBroker({ ...options, onError: stopReported.resolve }),
});
const installRuntime: typeof runtime = {
  ...runtime,
  filesystem: { ...runtime.filesystem, drain },
};

async function drain(): Promise<void> {
  await runtime.filesystem.drain();
  // Cross uninstall's drain catch and await before resuming the waiting-fence case.
  if (++drains === 2) queueMicrotask(() => queueMicrotask(() => fenceReady.resolve()));
}

const launcher: GuestLauncher = (context) => {
  context.started();
  contexts.push(context);
  return { terminate: () => terminate(context) };
};

function terminate(context: RuntimeProcessContext): void | Promise<void> {
  terminationCalls++;
  if (context !== contexts[0]) return;
  stopAttempted.resolve();
  if (scenario === "success") return stopAllowed.promise;
  if (scenario?.startsWith("sync")) throw failure;
  return stopAllowed.promise.then(() => Promise.reject(failure));
}

const packageUnderTest: ProgramPackage = {
  name: "termination-debt",
  programs: [{ path: "/bin/termination-debt", source: async () => wasiCat() }],
  dispose: async () => {
    disposals++;
  },
};
const replacement: ProgramPackage = {
  name: "distinct-replacement-without-disposer",
  programs: [{ path: "/bin/termination-debt", source: async () => wasiCat() }],
};

async function rejected(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => assert.fail("expected installation disposal to reject"),
    (error: unknown) => error,
  );
}

async function failStop(context: RuntimeProcessContext): Promise<void> {
  context.exit(0);
  await stopAttempted.promise;
  stopAllowed.resolve();
  assert.equal(await stopReported.promise, failure, "physical failure must reach the supervisor");
}

async function runScenario(): Promise<void> {
  const installation = await installPrograms(installRuntime, [packageUnderTest], { launcher });
  const shell = await createProgramShell(runtime, tables);
  const first = await shell.spawn("/bin/termination-debt", ["termination-debt"]);
  const firstContext = contexts[0];
  assert(firstContext, "spawn must publish a started handle before selecting its outcome");
  const second = scenario?.endsWith("second")
    ? await shell.spawn("/bin/termination-debt", ["termination-debt"])
    : undefined;
  assert.equal(contexts.length, second ? 2 : 1);

  if (scenario?.endsWith("later")) await failStop(firstContext);
  const disposal = installation.dispose();
  const outcome = disposal.catch((error: unknown) => error);
  if (!scenario?.endsWith("later")) await fenceReady.promise;
  if (scenario === "success") {
    await finishSuccess(firstContext, installation, disposal, first.exit);
    return;
  }
  if (!scenario?.endsWith("later")) await failStop(firstContext);
  assert.equal(await outcome, failure, "fence must reject with the exact physical failure");
  assert.equal(disposals, 0, "failed stop must retain the package payload");
  assert.equal(terminationCalls, 1, "known debt must reject even with another handle live");
  assert.equal(installation.dispose(), disposal, "disposal must cache its rejected promise");
  assert.equal(await rejected(installation.dispose()), failure);
  assert.equal(terminationCalls, 1, "disposal must not retry physical termination");
  assert.equal(await runtime.filesystem.lookup("/bin/termination-debt"), undefined);
  const conflict = await rejected(installPrograms(runtime, [replacement], { launcher }));
  assert(conflict instanceof Error && /already registered/.test(conflict.message));
  assert.equal(disposals, 0, "replacement rollback must not dispose the original package");
  if (second) {
    const context = contexts[1];
    assert(context);
    context.exit(0);
    await second.exit;
  }
  await first.exit;
}

async function finishSuccess(
  context: RuntimeProcessContext,
  installation: Awaited<ReturnType<typeof installPrograms>>,
  disposal: Promise<void>,
  exit: Promise<unknown>,
): Promise<void> {
  context.exit(0);
  await stopAttempted.promise;
  assert.equal(disposals, 0, "a delayed physical stop must still hold the payload");
  stopAllowed.resolve();
  await disposal;
  assert.equal(disposals, 1);
  assert.equal(installation.dispose(), disposal);
  const installedAgain = await installPrograms(runtime, [replacement], { launcher });
  await installedAgain.dispose();
  await exit;
  for (const table of tables) table.dispose();
  await runtime.dispose();
}

try {
  await runScenario();
  console.log(`termination debt ${scenario} passed`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
