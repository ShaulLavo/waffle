import { SharedFilesystem, type SharedFilesystemOptions } from "./browser/shared-fs";
import type { BrowserProcessBroker, BrowserProcessBrokerOptions } from "./browser/process-broker";
import { ProcessIdentityAllocator } from "./proc/identity";
import type { ExecutableRegistry, Executable } from "./proc/registry";
import type { ProcessSupervisor } from "./proc/supervisor";
import type { ProcessContext, ProcessHandle } from "./proc/types";

/** Filesystem authority is borrowed. Only the page runtime can close its service. */
export type RuntimeFilesystem = Omit<SharedFilesystem, "client" | "dispose">;
export type RuntimeSupervisor = Omit<ProcessSupervisor, "dispose">;
export type ProcessService = Omit<BrowserProcessBroker, "dispose" | "suspend" | "quiesce" | "ready"> & {
  ready(): Promise<RuntimeSupervisor>;
};
export type GuestLauncher = (context: ProcessContext, service: ProcessService) => ProcessHandle | Promise<ProcessHandle>;
export type ProgramDefinition = { readonly adapter: string } & (
  | { readonly source: Uint8Array | (() => Uint8Array | Promise<Uint8Array>); readonly module?: never; readonly cooperative?: never }
  | { readonly module: WebAssembly.Module | (() => WebAssembly.Module | Promise<WebAssembly.Module>); readonly cooperative: true; readonly source?: never }
);
export interface RuntimeOptions {
  filesystem?: SharedFilesystemOptions;
  /** Inject a host, not a second runtime. The factory receives this runtime's exact owners. */
  processHost?: (options: BrowserProcessBrokerOptions) => BrowserProcessBroker | Promise<BrowserProcessBroker>;
}
export interface Runtime {
  readonly filesystem: RuntimeFilesystem;
  /** Shared before process activation so synchronous worker stubs can reserve identities. */
  readonly identities: ProcessIdentityAllocator;
  readonly disposed: boolean;
  registerProgram(name: string, program: ProgramDefinition): void;
  registerAdapter(name: string, launch: GuestLauncher): void;
  processes(): Promise<ProcessService>;
  dispose(): Promise<void>;
}

const ownerKey = Symbol.for("waffle.runtime.owner");
const owners = globalThis as typeof globalThis & { [ownerKey]?: object };
const hostOwnership = new Set<PropertyKey>(["dispose", "suspend", "quiesce"]);
const supervisorOwnership = new Set<PropertyKey>(["dispose"]);
const filesystemOwnership = new Set<PropertyKey>(["dispose", "client"]);
const asyncFilesystem = new Set<PropertyKey>(["quiesce", "drain", "flush", "lookup", "readFile", "listFiles", "mkdirp", "writeFile", "remove", "move"]);

/** Keep method receivers on the owner, but never expose its teardown capabilities. */
function borrow<T extends object>(owner: T, excluded: ReadonlySet<PropertyKey>, assertLive: () => void,
  overrides = new Map<PropertyKey, unknown>(), asyncMethods = new Set<PropertyKey>()): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(owner, {
    get(target, key) {
      if (excluded.has(key)) return undefined;
      if (overrides.has(key)) return overrides.get(key);
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!methods.has(key)) methods.set(key, asyncMethods.has(key)
        ? async (...args: unknown[]) => { assertLive(); return Reflect.apply(value, target, args); }
        : (...args: unknown[]) => { assertLive(); return Reflect.apply(value, target, args); });
      return methods.get(key);
    },
    has: (target, key) => !excluded.has(key) && Reflect.has(target, key),
    ownKeys: target => Reflect.ownKeys(target).filter(key => !excluded.has(key)),
    getOwnPropertyDescriptor: (target, key) => excluded.has(key) ? undefined : Reflect.getOwnPropertyDescriptor(target, key),
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

/** The page is the sole owner. Duplicate bundles share only the guard, not a service locator. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  if (owners[ownerKey] !== undefined) throw new Error("A live page runtime already owns this page");
  const token = {};
  owners[ownerKey] = token;
  let filesystem: SharedFilesystem;
  let identities: ProcessIdentityAllocator;
  let registry: ExecutableRegistry | undefined;
  try {
    if (typeof SharedArrayBuffer !== "function") throw new Error("Page runtime requires SharedArrayBuffer and cross-origin isolation");
    identities = new ProcessIdentityAllocator();
    filesystem = new SharedFilesystem(options.filesystem);
  } catch (error) {
    if (owners[ownerKey] === token) delete owners[ownerKey];
    throw error;
  }
  const adapters = new Map<string, GuestLauncher>();
  const programs = new Map<string, Executable>();
  let disposed = false;
  let host: BrowserProcessBroker | undefined;
  let ownedActivation: Promise<BrowserProcessBroker> | undefined;
  let activation: Promise<ProcessService> | undefined;
  let disposal: Promise<void> | undefined;
  let service: ProcessService | undefined;
  const assertLive = () => { if (disposed) throw new Error("Runtime is disposed"); };
  const borrowedFilesystem = borrow(filesystem, filesystemOwnership, assertLive, undefined, asyncFilesystem);
  const suspend = (failures: unknown[]) => {
    if (!host) return;
    try { host.suspend(); } catch (error) { failures.push(error); }
  };
  const runtime: Runtime = {
    filesystem: borrowedFilesystem,
    identities,
    get disposed() { return disposed; },
    registerAdapter(name, launch) {
      assertLive();
      if (!name || typeof launch !== "function") throw new TypeError("Adapter name and launcher are required");
      if (adapters.has(name)) throw new Error(`Adapter already registered: ${name}`);
      adapters.set(name, launch);
    },
    registerProgram(name, program) {
      assertLive();
      if (!name || !program || !program.adapter) throw new TypeError("Program and adapter names are required");
      if (programs.has(name)) throw new Error(`Program already registered: ${name}`);
      if (!adapters.has(program.adapter)) throw new Error(`Unknown adapter: ${program.adapter}`);
      const source = program.source;
      const module = program.module;
      let executable: Executable;
      if (source !== undefined && module !== undefined) throw new TypeError("A program must choose either source bytes or a cooperative module");
      if (source !== undefined) {
        if (program.cooperative !== undefined) throw new TypeError("Source bytes use interrupt admission, not cooperative module trust");
        if (!(source instanceof Uint8Array) && typeof source !== "function") throw new TypeError("Program source must provide Wasm bytes");
        const ownedSource = source instanceof Uint8Array ? new Uint8Array(source) : source;
        executable = { adapter: program.adapter, module: async () => {
          assertLive();
          const bytes = typeof ownedSource === "function" ? await ownedSource() : ownedSource;
          if (!(bytes instanceof Uint8Array)) throw new TypeError("Program source loader must return Wasm bytes");
          // Own source bytes before an asynchronous import can yield to a mutating caller.
          const snapshot = new Uint8Array(bytes);
          const { compileInterruptible } = await import("./interrupt/loader");
          const compiled = await compileInterruptible(snapshot);
          assertLive();
          return compiled;
        } };
      } else {
        if (program.cooperative !== true) throw new TypeError("Compiled modules require cooperative: true");
        if (!(module instanceof WebAssembly.Module) && typeof module !== "function") throw new TypeError("Program module must provide a compiled WebAssembly.Module");
        executable = { adapter: program.adapter, module };
      }
      programs.set(name, executable);
      registry?.register(name, executable);
    },
    processes() {
      if (disposed) return Promise.reject(new Error("Runtime is disposed"));
      if (activation) return activation;
      const pendingHost = Promise.resolve().then(async (): Promise<BrowserProcessBroker> => {
        const [{ ExecutableRegistry }, { ProcessTable }] = await Promise.all([import("./proc/registry"), import("./proc/table")]);
        registry = new ExecutableRegistry();
        for (const [name, executable] of programs) registry.register(name, executable);
        const table = new ProcessTable(identities);
        const hostOptions: BrowserProcessBrokerOptions = {
          filesystem: {
            connect: identity => filesystem.connect(identity),
            revoke: identity => filesystem.revoke(identity),
            reap: identity => filesystem.reap(identity),
            quiesce: identity => filesystem.quiesce(identity),
            sweep: () => filesystem.client.sweep(),
          },
          identities, registry, table,
          launch: context => {
            assertLive();
            const launch = adapters.get(context.adapter);
            if (!launch) throw new Error(`Unknown adapter: ${context.adapter}`);
            return launch(context, service!);
          },
        };
        const created = await (options.processHost
          ? options.processHost(hostOptions)
          : import("./browser/process-broker").then(({ BrowserProcessBroker }) => new BrowserProcessBroker(hostOptions)));
        host = created;
        return created;
      });
      ownedActivation = pendingHost;
      activation = pendingHost.then(owner => {
        assertLive();
        const supervisors = new WeakMap<ProcessSupervisor, RuntimeSupervisor>();
        const ready = async () => {
          assertLive();
          const supervisor = await owner.ready();
          assertLive();
          let borrowed = supervisors.get(supervisor);
          if (!borrowed) { borrowed = borrow(supervisor, supervisorOwnership, assertLive); supervisors.set(supervisor, borrowed); }
          return borrowed;
        };
        service = borrow(owner, hostOwnership, assertLive, new Map([["ready", ready]])) as ProcessService;
        return service;
      });
      return activation;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      const failures: unknown[] = [];
      suspend(failures);
      disposal = Promise.resolve().then(async () => {
        const attempt = async (operation: () => unknown) => {
          try { await operation(); } catch (error) { failures.push(error); }
        };
        // Initialization is owned too. A factory already in flight cannot escape teardown.
        if (ownedActivation) {
          await attempt(async () => { host = await ownedActivation; });
          suspend(failures);
        }
        await attempt(() => filesystem.drain());
        // Keep the backend and relays alive while every admitted filesystem request fences.
        await Promise.all([
          attempt(() => host?.quiesce()),
          attempt(() => filesystem.quiesce(filesystem.client.connection)),
        ]);
        await attempt(() => host?.dispose());
        await attempt(() => filesystem.dispose());
        adapters.clear();
        for (const name of programs.keys()) registry?.unregister(name);
        programs.clear();
        if (owners[ownerKey] === token) delete owners[ownerKey];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Runtime disposal failed");
      });
      return disposal;
    },
  };
  return Object.freeze(runtime);
}
