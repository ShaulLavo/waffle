import assert from "node:assert/strict";
import { BrowserProcessBroker } from "../../browser/process-broker.js";
import { startCommand } from "../../proc/start-command.js";
import { createRuntime } from "../../runtime.js";

const failure = new Error("The page filesystem fence did not return");
let brokerDisposed = false;
class FailingBroker extends BrowserProcessBroker {
  override async quiesce(): Promise<void> {
    throw failure;
  }
  override dispose(): Promise<void> {
    brokerDisposed = true;
    return super.dispose();
  }
}
const runtime = createRuntime({
  filesystem: { mode: "memory", workerURL: new URL("../../browser/fs-worker.ts", import.meta.url) },
  processHost: (options) => new FailingBroker(options),
});
const entered = Promise.withResolvers<void>();
const cancelled = Promise.withResolvers<void>();
runtime.registerAdapter("control", (context) => {
  context.started();
  entered.resolve();
  return { terminate() {} };
});
runtime.registerProgram("/fixture", {
  adapter: "control",
  source: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
});
await runtime.filesystem.writeFile("/fixture", "");
const source = new ReadableStream<Uint8Array>({
  pull: () => new Promise(() => {}),
  cancel: () => cancelled.resolve(),
});
const command = startCommand(runtime, "/fixture", { filesystem: "runtime-root", stdin: source });
const outcome = command.result.catch((error) => error);
await entered.promise;
const disposal = runtime.dispose();
await assert.rejects(disposal, (error) => error === failure);
assert.equal(await outcome, failure);
await cancelled.promise;
assert.equal(source.locked, false);
assert.equal(brokerDisposed, false);
// Disposal deliberately retains the live runtime on this path. The isolated fixture exits.
process.exit(0);
