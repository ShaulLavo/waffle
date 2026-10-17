import { BrowserProcessBroker } from "@bun-wasm/runtime/browser/process-broker";
import { ExecutableRegistry } from "@bun-wasm/runtime/proc/registry";
import { ProcessIdentityAllocator } from "@bun-wasm/runtime/proc/identity";
import { ProcessTable } from "@bun-wasm/runtime/proc/table";
import { compileInterruptible } from "@bun-wasm/runtime/interrupt/loader";
import type { Runtime, GuestLauncher, ProcessService, RuntimeFilesystem } from "@bun-wasm/runtime";

/** A process-only fixture: no page owner, filesystem worker, browser cache or service locator.
 * Production composition is covered by the runtime facade tests; these inject explicit owners
 * so legacy transport regressions can independently control filesystem and activation barriers.
 */
export function processRuntimeFixture(filesystem: RuntimeFilesystem, options: {
  activate?: () => Promise<typeof import("@bun-wasm/runtime/proc")>;
} = {}): Runtime {
  const identities = new ProcessIdentityAllocator();
  const registry = new ExecutableRegistry();
  const table = new ProcessTable(identities);
  const adapters = new Map<string, GuestLauncher>();
  let broker: BrowserProcessBroker | undefined;
  let activation: Promise<ProcessService> | undefined;
  let disposed = false;
  let service!: ProcessService;
  return {
    filesystem, identities,
    get disposed() { return disposed; },
    registerAdapter(name, launch) {
      if (adapters.has(name)) throw new Error(`Adapter already registered: ${name}`);
      adapters.set(name, launch);
    },
    registerProgram(name, program) {
      if (registry.has(name)) throw new Error(`Program already registered: ${name}`);
      if (!adapters.has(program.adapter)) throw new Error(`Unknown adapter: ${program.adapter}`);
      registry.register(name, { adapter: program.adapter, interruptible: program.source !== undefined, module: program.source !== undefined ? async () => {
        const source = typeof program.source === "function" ? await program.source() : program.source!;
        return compileInterruptible(source);
      } : program.cooperative === true ? program.module : async () => { throw new TypeError("Third-party programs require source bytes"); } });
    },
    processes() {
      if (disposed) return Promise.reject(new Error("Runtime is disposed"));
      return activation ??= Promise.resolve().then(() => {
        broker = new BrowserProcessBroker({ filesystem, identities, registry, table, activate: options.activate,
          launch: context => {
            const launch = adapters.get(context.adapter);
            if (!launch) throw new Error(`Unknown adapter: ${context.adapter}`);
            return launch(context, service);
          },
        });
        if (disposed) broker.suspend();
        service = broker;
        return service;
      });
    },
    async dispose() {
      disposed = true;
      broker?.suspend();
      if (activation) await activation;
      await broker?.dispose();
    },
  };
}
