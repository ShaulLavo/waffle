import { createRuntime } from "../runtime.js";
import { CommandStdio } from "../proc/command-stdio.js";
import { commandShell } from "./program-host-command-fixture.js";

const runtime = createRuntime({
  filesystem: {
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  },
});
const callbacks = Promise.withResolvers<void>();
await runtime.programs.onDemand({
  name: "debt",
  programs: [
    {
      path: "/debt",
      command: {
        load: async () => async () => {
          callbacks.resolve();
          return 0;
        },
      },
    },
  ],
});
const original = CommandStdio.prototype.settle;
CommandStdio.prototype.settle = async function () {
  await original.call(this);
  throw new Error("injected physical I/O cleanup failure");
};
const shell = await commandShell(runtime, []);
const process = await shell.spawn("/debt");
await callbacks.promise;
await process.exit;
const disposal = await runtime.dispose().then(
  () => undefined,
  (error: unknown) => error,
);
if (!(disposal instanceof Error)) throw new Error("disposal must retain failed cleanup debt");
let guardRetained = false;
try {
  createRuntime();
} catch {
  guardRetained = true;
}
if (!guardRetained) throw new Error("failed physical cleanup released the page guard");
console.log("physical cleanup debt rejects disposal and retains the page guard");
globalThis.process.exit(0);
