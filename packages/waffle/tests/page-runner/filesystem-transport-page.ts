import { startPage } from "waffle/testing/page-runner/page";
import { observeFilesystemWorkers } from "./filesystem-transport-observation.js";

const id = "filesystem-transport: complete command";
let observation: ReturnType<typeof observeFilesystemWorkers> | undefined;
let pending: Promise<void> | undefined;
async function run(rounds: number): Promise<void> {
  if (pending) throw new Error("Filesystem transport command already started");
  const path = "/original.js";
  await import(path);
  const owner = observeFilesystemWorkers();
  observation = owner;
  pending = (async () => {
    try {
      const result = await window.run(rounds, 2, true);
      window.__filesystemTransport.value = { result, observation: owner.snapshot() };
    } catch (error) {
      throw error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
      owner.close();
    }
  })();
  await pending;
}
declare global {
  interface Window {
    __filesystemTransport: { run: typeof run; value: unknown };
  }
}
window.__filesystemTransport = { run, value: null };
startPage<{ rounds: number }>({
  list: async () => ({ ids: [id] }),
  run: {
    kind: "host",
    async teardown() {
      observation?.close();
      await pending?.catch(() => {});
      return {
        live: observation?.snapshot().live ?? 0,
        workerRestored: observation?.restored() ?? true,
      };
    },
  },
  async finish(ledger) {
    if (ledger.length) throw new Error("Filesystem transport uses no durable storage");
    return [];
  },
});
