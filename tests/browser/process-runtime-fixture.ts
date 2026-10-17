import { BrowserProcessBroker } from "@bun-wasm/runtime/browser/process-broker";
import { ExecutableRegistry } from "@bun-wasm/runtime/proc/registry";
import { ProcessIdentityAllocator } from "@bun-wasm/runtime/proc/identity";
import { ProcessTable } from "@bun-wasm/runtime/proc/table";
import { compileInterruptible } from "@bun-wasm/runtime/interrupt/loader";
import type { Runtime, GuestLauncher, ProcessService, RuntimeFilesystem, RuntimeConsumer } from "@bun-wasm/runtime";

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
  let disposal: Promise<void> | undefined;
  const consumers = new Set<RuntimeConsumer>();
  let service!: ProcessService;
  return {
    filesystem, identities,
    get disposed() { return disposed; },
    retainConsumer(consumer) {
      if (disposed) throw new Error("Runtime is disposed");
      consumers.add(consumer);
      return () => { if (!disposed) consumers.delete(consumer); };
    },
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
    dispose() {
      if (disposal) return disposal;
      const completion = Promise.withResolvers<void>();
      disposal = completion.promise;
      disposed = true;
      const retained = Array.from(consumers);
      const errors: unknown[] = [];
      for (const consumer of retained) {
        try { consumer.revoke(); } catch (error) { errors.push(error); }
        try { filesystem.revoke(consumer.filesystem); } catch (error) { errors.push(error); }
      }
      try { broker?.suspend(); } catch (error) { errors.push(error); }
      void Promise.resolve().then(async () => {
        try { if (activation) await activation; } catch (error) { errors.push(error); }
        // This process-only fixture owns the same pre-admission fence, not a no-op lease.
        // A rejected fence prevents physical cleanup, as it does in the real page owner.
        const fences = await Promise.allSettled(retained.map(consumer => Promise.resolve().then(() => filesystem.quiesce(consumer.filesystem))));
        const failures = fences.filter(result => result.status === "rejected").map(result => result.reason);
        if (!failures.length) {
          const stops = await Promise.allSettled(retained.map(consumer => Promise.resolve().then(() => consumer.stop())));
          for (const result of stops) if (result.status === "rejected") errors.push(result.reason);
          consumers.clear();
        }
        try {
          if (failures.length) await broker?.quiesce();
          else await broker?.dispose();
        } catch (error) { errors.push(error); }
        if (errors.length || failures.length) throw new AggregateError(errors.concat(failures), "Process fixture disposal failed");
      }).then(completion.resolve, completion.reject);
      return disposal;
    },
  };
}
