import { SharedFilesystem, type SharedFilesystemOptions } from "./browser/shared-fs.js";
import type {
  BrowserProcessBroker,
  BrowserProcessBrokerOptions,
} from "./browser/process-broker.js";
import { ProcessIdentityAllocator } from "./proc/identity.js";
import type { ExecutableRegistry, Executable } from "./proc/registry.js";
import type { ProcessSupervisor } from "./proc/supervisor.js";
import type { ProcessContext, ProcessHandle } from "./proc/types.js";
import type { FilesystemIdentity } from "./fs/protocol.js";
import type { ProcessAdmissionObserver } from "./proc/admission.js";
import type { RuntimeStartupObserver } from "./fs/startup.js";
export type { RuntimeStartupStage, RuntimeStartupObserver } from "./fs/startup.js";
export type {
  SharedFilesystemOptions,
  SharedFilesystemState,
  SharedFilesystemStatus,
  SharedFilesystemStateObserver,
} from "./browser/shared-fs.js";
export { getVfsDescriptor, VfsError } from "./fs/vfs.js";
export type { VfsMode, VfsDescriptor, VfsSelection, VfsWhenBusy, VfsErrorCode } from "./fs/vfs.js";
export type { ProcessAdmissionEvent, ProcessAdmissionObserver } from "./proc/admission.js";

/** Adapter-only ownership of a synchronously accepted consumer before lazy process admission. */
export interface RuntimeConsumer {
  readonly filesystem: FilesystemIdentity;
  /** Select logical cancellation without physically stopping the consumer. */
  revoke(): void;
  /** Physical cleanup; the runtime invokes this only after successful filesystem fences. */
  stop(): void | Promise<void>;
}

/** Filesystem authority is borrowed. Only the page runtime can close its service. */
export type RuntimeFilesystem = Omit<SharedFilesystem, "client" | "dispose">;
export type RuntimeSupervisor = Omit<ProcessSupervisor, "dispose">;
export type ProcessService = Omit<
  BrowserProcessBroker,
  "dispose" | "suspend" | "quiesce" | "ready"
> & {
  ready(): Promise<RuntimeSupervisor>;
};
export type GuestLauncher = (
  context: ProcessContext,
  service: ProcessService,
) => ProcessHandle | Promise<ProcessHandle>;
export type ProgramDefinition = { readonly adapter: string } & (
  | {
      readonly source: Uint8Array | (() => Uint8Array | Promise<Uint8Array>);
      readonly module?: never;
      readonly cooperative?: never;
    }
  | {
      readonly module:
        | WebAssembly.Module
        | (() => WebAssembly.Module | Promise<WebAssembly.Module>);
      readonly cooperative: true;
      readonly source?: never;
    }
);
export interface RuntimeOptions {
  filesystem?: SharedFilesystemOptions;
  /** Inject a host, not a second runtime. The factory receives this runtime's exact owners. */
  processHost?: (
    options: BrowserProcessBrokerOptions,
  ) => BrowserProcessBroker | Promise<BrowserProcessBroker>;
  /** Optional admission metadata; retain a bounded history in the consumer if needed.
   * Observers must not reenter process control. Throws and rejected async returns are ignored. */
  onProcessAdmission?: ProcessAdmissionObserver;
  /** Optional filesystem startup milestones, never awaited. See docs/runtime-startup.md. */
  onStartupStage?: RuntimeStartupObserver;
}
export interface Runtime {
  readonly filesystem: RuntimeFilesystem;
  /** Shared before process activation so synchronous worker stubs can reserve identities. */
  readonly identities: ProcessIdentityAllocator;
  readonly disposed: boolean;
  /** Register an absolute canonical path; the caller creates its regular file before spawn.
   * Releasing the lease removes only this registration, never files or running processes. */
  registerProgram(name: string, program: ProgramDefinition): () => void;
  /** Releasing the lease removes only this registration, never running processes. */
  registerAdapter(name: string, launch: GuestLauncher): () => void;
  /** Adapter plumbing, not an application/shell API. Release only after another owner accepts
   * the consumer synchronously, or its physical cleanup is proven complete. */
  retainConsumer(consumer: RuntimeConsumer): () => void;
  processes(): Promise<ProcessService>;
  dispose(): Promise<void>;
}

const ownerKey = Symbol.for("waffle.runtime.owner");
const owners = globalThis as typeof globalThis & { [ownerKey]?: object };
type CapabilityKind = "method" | "async" | "readonly" | "callback";
// Positive, exhaustive projections: a new public owner member requires an explicit capability
// decision here. TypeScript-private owner fields and future implementation details never leak.
const filesystemCapabilities = {
  createIdentity: "method",
  fork: "method",
  connect: "method",
  revoke: "method",
  reap: "method",
  quiesce: "async",
  drain: "async",
  flush: "async",
  resolvePath: "async",
  lookup: "async",
  readFile: "async",
  listFiles: "async",
  mkdirp: "async",
  writeFile: "async",
  remove: "async",
  move: "async",
  state: "readonly",
  vfs: "readonly",
  ownershipLost: "readonly",
  onOwnershipLost: "callback",
  onStateChange: "callback",
} satisfies Record<keyof RuntimeFilesystem, CapabilityKind>;
const processCapabilities = {
  ready: "async",
  registerController: "method",
  reserveRoot: "method",
  retainRoot: "method",
  adoptRoot: "async",
  adoptRuntimeRoot: "async",
  revokeRuntimeProcess: "method",
  runtimeMessage: "async",
  rejectRuntimeMessage: "method",
  transportFor: "method",
  releaseLegacyJob: "method",
  launchWorker: "method",
  kill: "async",
  killJob: "async",
  rootExit: "async",
} satisfies Record<keyof ProcessService, CapabilityKind>;
const supervisorCapabilities = {
  table: "readonly",
  get: "method",
  job: "method",
  jobOf: "method",
  canSignal: "method",
  canSignalJob: "method",
  canWaitJob: "method",
  accessStart: "method",
  accessTake: "method",
  accessCancel: "method",
  accessReady: "method",
  registerJobReadiness: "method",
  registerJobReapClaim: "method",
  registerChildAccess: "method",
  onJobReap: "method",
  jobEmpty: "method",
  registerJobWake: "method",
  createRoot: "method",
  reserveSpawn: "method",
  reserveAdmittedSpawn: "method",
  spawn: "method",
  start: "async",
  started: "method",
  startStatus: "method",
  registerChildStartWake: "method",
  failStart: "method",
  exit: "method",
  kill: "method",
  observeSignal: "method",
  defaultSignal: "method",
  killJob: "method",
  wait: "method",
  childExited: "method",
  waitJob: "method",
  reapJob: "method",
  reconcileCollectedJob: "method",
  waitForExit: "async",
  reap: "method",
  onChildExit: "method",
  onProcessQuiescent: "method",
  registerRevocation: "method",
} satisfies Record<keyof RuntimeSupervisor, CapabilityKind>;

/** Fresh capabilities, never an owner-backed Proxy. Even descriptors and prototype inspection
 * expose only wrappers/getters; the owner is reachable solely through their private closures.
 */
function borrow<T extends object>(
  owner: T,
  capabilities: Record<keyof T, CapabilityKind>,
  assertLive: () => void,
  overrides = new Map<PropertyKey, unknown>(),
): T {
  const projection = Object.create(null) as T;
  for (const [key, kind] of Object.entries(capabilities)) {
    if (kind === "readonly") {
      Object.defineProperty(projection, key, {
        enumerable: true,
        get: () => Reflect.get(owner, key, owner),
      });
      continue;
    }
    if (kind === "callback") {
      let callback: unknown = Reflect.get(owner, key, owner);
      // Owner-side method invocation must not give a consumer callback the private owner as `this`.
      const bridge = (value: unknown) =>
        typeof value === "function"
          ? (...args: unknown[]) => Reflect.apply(value, projection, args)
          : value;
      Reflect.set(owner, key, bridge(callback), owner);
      Object.defineProperty(projection, key, {
        enumerable: true,
        get: () => callback,
        set: (value: unknown) => {
          assertLive();
          Reflect.set(owner, key, bridge(value), owner);
          callback = value;
        },
      });
      continue;
    }
    const invoke = (args: unknown[]) => {
      assertLive();
      const method: unknown = overrides.has(key)
        ? overrides.get(key)
        : Reflect.get(owner, key, owner);
      if (typeof method !== "function") throw new TypeError(`Missing runtime capability: ${key}`);
      return Reflect.apply(method, owner, args);
    };
    Object.defineProperty(projection, key, {
      enumerable: true,
      value:
        kind === "async"
          ? async (...args: unknown[]) => invoke(args)
          : (...args: unknown[]) => invoke(args),
    });
  }
  return Object.freeze(projection);
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
    if (typeof SharedArrayBuffer !== "function")
      throw new Error("Page runtime requires SharedArrayBuffer and cross-origin isolation");
    identities = new ProcessIdentityAllocator();
    filesystem = new SharedFilesystem(options.filesystem, options.onStartupStage);
  } catch (error) {
    if (owners[ownerKey] === token) delete owners[ownerKey];
    throw error;
  }
  const adapters = new Map<string, GuestLauncher>();
  const programs = new Map<string, Executable>();
  const launching = new Set<Promise<ProcessHandle>>();
  const handles = new Set<ProcessHandle>();
  const consumers = new Set<RuntimeConsumer>();
  let disposed = false;
  let host: BrowserProcessBroker | undefined;
  let ownedActivation: Promise<BrowserProcessBroker> | undefined;
  let activation: Promise<ProcessService> | undefined;
  let disposal: Promise<void> | undefined;
  let terminationFence: Promise<void> | undefined;
  let service: ProcessService | undefined;
  const assertLive = () => {
    if (disposed) throw new Error("Runtime is disposed");
  };
  const borrowedFilesystem = borrow<RuntimeFilesystem>(
    filesystem,
    filesystemCapabilities,
    assertLive,
  );
  const suspend = (failures: unknown[]) => {
    if (!host) return;
    try {
      host.suspend();
    } catch (error) {
      failures.push(error);
    }
  };
  const runtime: Runtime = {
    filesystem: borrowedFilesystem,
    identities,
    get disposed() {
      return disposed;
    },
    registerAdapter(name, launch) {
      assertLive();
      if (!name || typeof launch !== "function")
        throw new TypeError("Adapter name and launcher are required");
      if (adapters.has(name)) throw new Error(`Adapter already registered: ${name}`);
      adapters.set(name, launch);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        if (!disposed && adapters.get(name) === launch) adapters.delete(name);
      };
    },
    registerProgram(name, program) {
      assertLive();
      if (!name || !program || !program.adapter)
        throw new TypeError("Program and adapter names are required");
      if (
        !name.startsWith("/") ||
        name === "/" ||
        name
          .slice(1)
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      ) {
        throw new TypeError(
          "Program name must be an absolute canonical file path, for example /bin/bun; create its file with runtime.filesystem.writeFile before spawning",
        );
      }
      if (programs.has(name)) throw new Error(`Program already registered: ${name}`);
      if (!adapters.has(program.adapter)) throw new Error(`Unknown adapter: ${program.adapter}`);
      const source = program.source;
      const module = program.module;
      let executable: Executable;
      if (source !== undefined && module !== undefined)
        throw new TypeError("A program must choose either source bytes or a cooperative module");
      if (source !== undefined) {
        if (program.cooperative !== undefined)
          throw new TypeError("Source bytes use interrupt admission, not cooperative module trust");
        if (!(source instanceof Uint8Array) && typeof source !== "function")
          throw new TypeError("Program source must provide Wasm bytes");
        const ownedSource = source instanceof Uint8Array ? new Uint8Array(source) : source;
        executable = {
          adapter: program.adapter,
          interruptible: true,
          module: async () => {
            assertLive();
            const bytes = typeof ownedSource === "function" ? await ownedSource() : ownedSource;
            if (!(bytes instanceof Uint8Array))
              throw new TypeError("Program source loader must return Wasm bytes");
            // Own source bytes before an asynchronous import can yield to a mutating caller.
            const snapshot = new Uint8Array(bytes);
            const { compileInterruptible } = await import("./interrupt/loader.js");
            const compiled = await compileInterruptible(snapshot);
            assertLive();
            return compiled;
          },
        };
      } else {
        if (program.cooperative !== true)
          throw new TypeError("Compiled modules require cooperative: true");
        if (!(module instanceof WebAssembly.Module) && typeof module !== "function")
          throw new TypeError("Program module must provide a compiled WebAssembly.Module");
        executable = { adapter: program.adapter, interruptible: false, module };
      }
      programs.set(name, executable);
      registry?.register(name, executable);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        if (disposed || programs.get(name) !== executable) return;
        programs.delete(name);
        registry?.unregister(name);
      };
    },
    retainConsumer(consumer) {
      assertLive();
      // Capture authority and callbacks before admission. Accessors can reenter disposal;
      // the final liveness check prevents inserting behind its synchronous ownership snapshot.
      const identity = consumer.filesystem;
      const filesystem = { ...identity, revocations: identity.revocations.slice() };
      const revoke = consumer.revoke.bind(consumer),
        stop = consumer.stop.bind(consumer);
      assertLive();
      const owned: RuntimeConsumer = { filesystem, revoke, stop };
      consumers.add(owned);
      return () => {
        // Disposal now owns this fence and stop, including releases from cancellation hooks.
        if (!disposed) consumers.delete(owned);
      };
    },
    processes() {
      if (disposed) return Promise.reject(new Error("Runtime is disposed"));
      if (activation) return activation;
      const pendingHost = Promise.resolve().then(async (): Promise<BrowserProcessBroker> => {
        const [{ ExecutableRegistry }, { ProcessTable }] = await Promise.all([
          import("./proc/registry.js"),
          import("./proc/table.js"),
        ]);
        registry = new ExecutableRegistry((path) => filesystem.resolvePath(path));
        for (const [name, executable] of programs) registry.register(name, executable);
        const table = new ProcessTable(identities);
        const hostOptions: BrowserProcessBrokerOptions = {
          filesystem: {
            connect: (identity) => filesystem.connect(identity),
            revoke: (identity) => filesystem.revoke(identity),
            reap: (identity) => filesystem.reap(identity),
            quiesce: (identity) => filesystem.quiesce(identity),
            sweep: () => filesystem.client.sweep(),
          },
          identities,
          registry,
          table,
          onProcessAdmission: options.onProcessAdmission,
          launch: (context) => {
            assertLive();
            const launch = adapters.get(context.adapter);
            if (!launch) throw new Error(`Unknown adapter: ${context.adapter}`);
            const pending = Promise.resolve(launch(context, service!)).then((handle) => {
              if (!handle || typeof handle.terminate !== "function")
                throw new TypeError("Adapter launcher must return a process handle");
              let stopping: Promise<void> | undefined;
              const owned: ProcessHandle = {
                terminate() {
                  if (!stopping) {
                    stopping = Promise.resolve().then(async () => {
                      // Suspension can ask the supervisor to stop a handle immediately. Its raw
                      // consumer must stay alive until this page's admitted filesystem work fences.
                      if (terminationFence) await terminationFence;
                      return handle.terminate();
                    });
                    void stopping.then(
                      () => handles.delete(owned),
                      () => {},
                    );
                  }
                  return stopping;
                },
              };
              handles.add(owned);
              return owned;
            });
            launching.add(pending);
            void pending.then(
              () => launching.delete(pending),
              () => launching.delete(pending),
            );
            return pending;
          },
        };
        const created = await (options.processHost
          ? options.processHost(hostOptions)
          : import("./browser/process-broker.js").then(
              ({ BrowserProcessBroker }) => new BrowserProcessBroker(hostOptions),
            ));
        host = created;
        return created;
      });
      ownedActivation = pendingHost;
      activation = pendingHost.then((owner) => {
        assertLive();
        const supervisors = new WeakMap<ProcessSupervisor, RuntimeSupervisor>();
        const ready = async () => {
          assertLive();
          const supervisor = await owner.ready();
          assertLive();
          let borrowed = supervisors.get(supervisor);
          if (!borrowed) {
            borrowed = borrow<RuntimeSupervisor>(supervisor, supervisorCapabilities, assertLive);
            supervisors.set(supervisor, borrowed);
          }
          return borrowed;
        };
        service = borrow<ProcessService>(
          owner,
          processCapabilities,
          assertLive,
          new Map([["ready", ready]]),
        );
        return service;
      });
      return activation;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      let releaseTermination!: () => void;
      terminationFence = new Promise<void>((resolve) => {
        releaseTermination = resolve;
      });
      const failures: unknown[] = [];
      const throwFailures = () => {
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Runtime disposal failed");
      };
      const pendingStartup =
        filesystem.vfs.persistent &&
        (filesystem.state.status === "opening" || filesystem.state.status === "waiting");
      disposal = Promise.resolve().then(async () => {
        const attempt = async (operation: () => unknown) => {
          try {
            await operation();
          } catch (error) {
            failures.push(error);
          }
        };
        // Initialization is owned too. A factory already in flight cannot escape teardown.
        if (ownedActivation) {
          await attempt(async () => {
            host = await ownedActivation;
          });
          suspend(failures);
        }
        // A controller may be awaiting an adapter's launch handle when suspension wins.
        // Its late handle and asynchronous stop still belong to this page, not the next owner.
        while (launching.size) await Promise.allSettled(Array.from(launching));
        if (!pendingStartup) await attempt(() => filesystem.drain());
        // Keep the backend and relays alive while every admitted filesystem request fences.
        const failuresBeforeFences = failures.length;
        await Promise.all(
          [
            attempt(() => host?.quiesce()),
            attempt(() => filesystem.quiesce(filesystem.client.connection)),
          ].concat(
            Array.from(consumers, (consumer) =>
              attempt(() => filesystem.quiesce(consumer.filesystem)),
            ),
          ),
        );
        // Rejection is not a proof of quiescence. Retain consumers, filesystem and the page
        // guard until this page is destroyed rather than allowing a new owner to overlap them.
        if (failures.length !== failuresBeforeFences) throwFailures();
        releaseTermination();
        await Promise.all(
          Array.from(handles, (handle) => attempt(() => handle.terminate())).concat(
            Array.from(consumers, (consumer) => attempt(() => consumer.stop())),
          ),
        );
        handles.clear();
        consumers.clear();
        await attempt(() => host?.dispose());
        await attempt(() => filesystem.dispose());
        adapters.clear();
        for (const name of programs.keys()) registry?.unregister(name);
        programs.clear();
        if (owners[ownerKey] === token) delete owners[ownerKey];
        throwFailures();
      });
      // Wake page operations before activation/drain can await startup. Keep the worker
      // and any acquired ownership alive until admitted consumer sections have fenced;
      // the normal final filesystem.dispose() then performs the startup abort handshake.
      if (pendingStartup) {
        try {
          filesystem.revoke(filesystem.client.connection);
        } catch (error) {
          failures.push(error);
        }
      }
      // Suspension itself remains synchronous so no new work can race teardown admission.
      for (const consumer of consumers) {
        try {
          filesystem.revoke(consumer.filesystem);
        } catch (error) {
          failures.push(error);
        }
        try {
          consumer.revoke();
        } catch (error) {
          failures.push(error);
        }
      }
      suspend(failures);
      return disposal;
    },
  };
  return Object.freeze(runtime);
}
