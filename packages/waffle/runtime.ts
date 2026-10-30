import {
  ProgramCollection,
  type ProgramsOptions,
  type RuntimePrograms,
} from "./programs/collection.js";
import type { RuntimeNetwork } from "./browser/net/runtime.js";
export type {
  RuntimeNetwork,
  RuntimeNetworkHelper,
  RuntimeNetworkPathScope,
} from "./browser/net/runtime.js";
export {
  RuntimeNetworkLookupError,
  type RuntimeNetworkLookupErrorCode,
  type RuntimeNetworkLookupOptions,
  type RuntimeNetworkLookupResult,
} from "./browser/net/address.js";

type RuntimeNetworkOwner = Awaited<
  ReturnType<(typeof import("./browser/net/runtime.js"))["createRuntimeNetwork"]>
>;

import { SharedFilesystem, type SharedFilesystemOptions } from "./browser/shared-fs.js";
import type {
  BrowserProcessBroker,
  BrowserProcessBrokerOptions,
} from "./browser/process-broker.js";
export type { WorkerMemoryObservation } from "./browser/process-broker.js";
export type { MemoryGroupLaunch, RootMemoryGroupMember } from "./browser/process-broker.js";
import type { MemoryGroupPolicyOptions } from "./group/state.js";
export type {
  MemoryGroupHandle,
  MemoryGroupPolicyOptions,
  MemoryGroupSnapshot,
} from "./group/state.js";
import {
  createProcessIdentity,
  snapshotHostIdentity,
  type RuntimeHostIdentity,
  type RuntimeProcessIdentity,
} from "./browser/process-context.js";
export type { RuntimeHostIdentity, RuntimeProcessIdentity } from "./browser/process-context.js";
import { ProcessIdentityAllocator } from "./proc/identity.js";
import type { HostCommand } from "./proc/command.js";
import { ExecutableFormatError } from "./proc/start-failure.js";
import type { CommandExecutable, RegisteredCommand } from "./proc/registry.js";
import type { ExecutableRegistry, Executable, ScriptExecutable } from "./proc/registry.js";
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
  RemoveCondition,
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
export type RuntimeFilesystem = Omit<SharedFilesystem, "client" | "dispose" | "attachSocketScope">;
export type RuntimeSupervisor = Omit<
  ProcessSupervisor,
  "dispose" | "registerOwnedJobCleanup" | "onJobRetirement" | "jobRetired" | "retireFencedProcesses"
>;
export type ProcessService = Omit<
  BrowserProcessBroker,
  "dispose" | "suspend" | "quiesce" | "ready"
> & {
  ready(): Promise<RuntimeSupervisor>;
};
export type RuntimeProcessContext = ProcessContext & {
  readonly identity: RuntimeProcessIdentity;
};
export type GuestLauncher = (
  context: RuntimeProcessContext,
  service: ProcessService,
) => ProcessHandle | Promise<ProcessHandle>;
export type ProgramLoadState =
  | { readonly kind: "registered" | "preparing" | "loaded" }
  | { readonly kind: "error"; readonly error: unknown };
export type ProgramDefinition = {
  readonly onLoad?: (state: ProgramLoadState) => void;
} & (
  | {
      readonly adapter: string;
      readonly command?: never;
      readonly source: Uint8Array | (() => Uint8Array | Promise<Uint8Array>);
      readonly module?: never;
      readonly cooperative?: never;
      readonly script?: never;
    }
  | {
      readonly adapter: string;
      readonly command?: never;
      readonly module:
        | WebAssembly.Module
        | (() => WebAssembly.Module | Promise<WebAssembly.Module>);
      readonly cooperative: true;
      readonly source?: never;
      readonly script?: never;
    }
  | {
      readonly adapter: string;
      readonly command?: never;
      readonly script: { readonly interpreter: string; readonly prepare: () => Promise<void> };
      readonly source?: never;
      readonly module?: never;
      readonly cooperative?: never;
    }
  | {
      readonly command: RegisteredCommand;
      readonly adapter?: never;
      readonly source?: never;
      readonly module?: never;
      readonly cooperative?: never;
      readonly script?: never;
    }
);
export interface RuntimeOptions {
  readonly programs?: ProgramsOptions;
  /** Explicit runtime host identity. Omission leaves host identity unsupported. */
  hostIdentity?: RuntimeHostIdentity;
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
  /** Memory group limits: members, parallelism, page budget. See docs/memory-groups.md. */
  memoryGroups?: MemoryGroupPolicyOptions;
}
export interface Runtime {
  readonly programs: RuntimePrograms;
  readonly hostIdentity: RuntimeHostIdentity | null;
  readonly filesystem: RuntimeFilesystem;
  /** Shared before process activation so synchronous worker stubs can reserve identities. */
  readonly identities: ProcessIdentityAllocator;
  readonly disposed: boolean;
  /** Register an absolute canonical path; the caller creates its regular file before spawn.
   * Paths registered with the same source loader function share one compiled module.
   * Releasing the lease removes only this registration, never files or running processes. */
  registerProgram(name: string, program: ProgramDefinition): () => void;
  /** Releasing the lease removes only this registration, never running processes. */
  registerAdapter(name: string, launch: GuestLauncher): () => void;
  /** Adapter plumbing, not an application/shell API. Release only after another owner accepts
   * the consumer synchronously, or its physical cleanup is proven complete. */
  retainConsumer(consumer: RuntimeConsumer): () => void;
  /** Lazy runtime-owned localhost services, independent of process activation. */
  network(): Promise<RuntimeNetwork>;
  processes(): Promise<ProcessService>;
  dispose(): Promise<void>;
}

const ownerKey = Symbol.for("waffle.runtime.owner");
const owners = globalThis as typeof globalThis & { [ownerKey]?: object };
type CapabilityKind = "method" | "async" | "readonly" | "callback";
// Positive, exhaustive projections: a new public owner member requires an explicit capability
// decision here. TypeScript-private owner fields and future implementation details never leak.
const filesystemCapabilities = {
  directoryHandle: "async",
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
  workspace: "readonly",
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
  networkPathScope: "method",
  outputDrained: "method",
  workerMemory: "method",
  memoryGroupOf: "method",
  memoryGroups: "method",
  admitRootMemoryGroup: "method",
  takeWorker: "method",
  isIdleWorker: "method",
  kill: "async",
  killJob: "async",
  rootExit: "async",
} satisfies Record<keyof ProcessService, CapabilityKind>;
const supervisorCapabilities = {
  table: "readonly",
  get: "method",
  job: "method",
  jobOf: "method",
  cwd: "method",
  canSignal: "method",
  canSignalJob: "method",
  canWaitJob: "method",
  accessStart: "method",
  accessTake: "method",
  accessCancel: "method",
  accessReady: "method",
  registerJobReadiness: "method",
  jobCleanupReady: "method",
  registerJobReapClaim: "method",
  registerChildAccess: "method",
  onJobReap: "method",
  jobEmpty: "method",
  registerJobWake: "method",
  registerJobCleanupWake: "method",
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

type PhysicalStop = () => void | Promise<void>;

function joinStop({
  owner,
  stop,
  physicalStops,
  cleanupDebt,
}: {
  owner: object;
  stop: PhysicalStop;
  physicalStops: Map<object, PhysicalStop>;
  cleanupDebt: Map<object, Promise<void>>;
}): Promise<void> {
  let joined: Promise<void>;
  try {
    joined = Promise.resolve(stop());
  } catch (error) {
    joined = Promise.reject(error);
  }
  cleanupDebt.set(owner, joined);
  void joined.then(
    () => {
      cleanupDebt.delete(owner);
      physicalStops.delete(owner);
    },
    () => {},
  );
  return joined;
}

function stopFailures(results: readonly PromiseSettledResult<void>[]): unknown[] {
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

/** The page is the sole owner. Duplicate bundles share only the guard, not a service locator. */
function sourceTime(): number | undefined {
  try {
    return performance.now();
  } catch {
    return undefined;
  }
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const hostIdentity = snapshotHostIdentity(options.hostIdentity);
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
  const programs = new Map<string, Executable | ScriptExecutable | CommandExecutable>();
  let registryActivation: Promise<ExecutableRegistry> | undefined;
  const getRegistry = (): Promise<ExecutableRegistry> => {
    registryActivation ??= import("./proc/registry.js").then(({ ExecutableRegistry }) => {
      registry = new ExecutableRegistry(
        (path) => filesystem.resolvePath(path),
        (path) => filesystem.readFile(path),
      );
      for (const [name, executable] of programs) registry.register(name, executable);
      return registry;
    });
    return registryActivation;
  };
  const launching = new Set<Promise<ProcessHandle>>();
  const physicalStops = new Map<object, PhysicalStop>();
  const cleanupDebt = new Map<object, Promise<void>>();
  const consumers = new Set<RuntimeConsumer>();
  let disposed = false;
  let host: BrowserProcessBroker | undefined;
  let ownedActivation: Promise<BrowserProcessBroker> | undefined;
  let activation: Promise<ProcessService> | undefined;
  let ownedNetwork: Promise<RuntimeNetworkOwner | undefined> | undefined;
  let networkActivation: Promise<RuntimeNetwork> | undefined;
  let disposal: Promise<void> | undefined;
  let terminationFence: Promise<void> | undefined;
  let service: ProcessService | undefined;
  const assertLive = () => {
    if (disposed) throw new Error("Runtime is disposed");
  };
  // One loader per source function, so a program registered at several paths compiles once.
  const sourceModules = new WeakMap<object, Executable["module"]>();
  const sourceModule = (
    source: Uint8Array | (() => Uint8Array | Promise<Uint8Array>),
    onLoad: ProgramDefinition["onLoad"],
  ) => {
    const shared = typeof source === "function" ? sourceModules.get(source) : undefined;
    if (shared) return shared;
    const ownedSource = source instanceof Uint8Array ? new Uint8Array(source) : source;
    const module = async () => {
      assertLive();
      onLoad?.({ kind: "preparing" });
      try {
        assertLive();
        const sourceStart = sourceTime();
        const bytes = typeof ownedSource === "function" ? await ownedSource() : ownedSource;
        const sourceEnd = sourceTime();
        if (!(bytes instanceof Uint8Array))
          throw new TypeError("Program source loader must return Wasm bytes");
        // Own source bytes before an asynchronous import can yield to a mutating caller.
        const snapshot = new Uint8Array(bytes);
        const { compileInterruptible, programStage } = await import("./interrupt/loader.js");
        if (sourceStart !== undefined && sourceEnd !== undefined)
          programStage("source", sourceStart, { bytes: snapshot.byteLength }, sourceEnd);
        const compiled = await compileInterruptible(snapshot);
        assertLive();
        onLoad?.({ kind: "loaded" });
        return compiled;
      } catch (error) {
        onLoad?.({ kind: "error", error });
        throw error;
      }
    };
    if (typeof source === "function") sourceModules.set(source, module);
    return module;
  };
  const commandLoads = new WeakMap<RegisteredCommand["load"], RegisteredCommand["load"]>();
  const commandLoader = (load: RegisteredCommand["load"], onLoad: ProgramDefinition["onLoad"]) => {
    const existing = commandLoads.get(load);
    if (existing) return existing;
    const shared = async (): Promise<HostCommand> => {
      assertLive();
      onLoad?.({ kind: "preparing" });
      try {
        const run = await load();
        if (typeof run !== "function") throw new TypeError("Command loader must return a function");
        assertLive();
        onLoad?.({ kind: "loaded" });
        return run;
      } catch (error) {
        onLoad?.({ kind: "error", error });
        throw error;
      }
    };
    commandLoads.set(load, shared);
    return shared;
  };
  const ownLaunch = (
    launch: () => ProcessHandle | Promise<ProcessHandle>,
  ): Promise<ProcessHandle> => {
    const pending = Promise.resolve()
      .then(launch)
      .then((handle) => {
        if (!handle || typeof handle.terminate !== "function")
          throw new TypeError("Launcher must return a process handle");
        let stopping: Promise<void> | undefined;
        const owned: ProcessHandle = {
          terminate() {
            stopping ??= Promise.resolve().then(async () => {
              if (terminationFence) await terminationFence;
              await handle.terminate();
              physicalStops.delete(owned);
            });
            return stopping;
          },
        };
        physicalStops.set(owned, owned.terminate);
        return owned;
      });
    launching.add(pending);
    void pending.then(
      () => launching.delete(pending),
      () => launching.delete(pending),
    );
    return pending;
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
    hostIdentity,
    get programs() {
      return programCollection.view;
    },
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
      if (!name || !program || (!program.command && !program.adapter))
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
      if (program.adapter && !adapters.has(program.adapter))
        throw new Error(`Unknown adapter: ${program.adapter}`);
      const source = program.source;
      const module = program.module;
      let executable: Executable | ScriptExecutable | CommandExecutable;
      if (source !== undefined && module !== undefined)
        throw new TypeError("A program must choose either source bytes or a cooperative module");
      if (program.command) {
        if (
          program.adapter !== undefined ||
          source !== undefined ||
          module !== undefined ||
          program.script !== undefined ||
          program.cooperative !== undefined
        )
          throw new TypeError("A command must declare only its command definition");
        const command = program.command;
        if (typeof command.load !== "function") throw new TypeError("Command loader is required");
        executable = {
          command: Object.freeze({
            ...command,
            ...(command.marker ? { marker: new Uint8Array(command.marker) } : {}),
            load: commandLoader(command.load, program.onLoad),
          }),
        };
      } else if (program.script) {
        if (source !== undefined || module !== undefined || program.cooperative !== undefined)
          throw new TypeError("A script must declare only its interpreter and preparation");
        if (
          !program.script.interpreter.startsWith("/") ||
          typeof program.script.prepare !== "function"
        )
          throw new TypeError(
            "Scripts require an absolute interpreter path and preparation function",
          );
        executable = {
          adapter: program.adapter,
          script: {
            interpreter: program.script.interpreter,
            prepare: sharedPreparation(program.script.prepare, program.onLoad, assertLive),
          },
          onLoad: program.onLoad,
        };
      } else if (source !== undefined) {
        if (program.cooperative !== undefined)
          throw new TypeError("Source bytes use interrupt admission, not cooperative module trust");
        if (!(source instanceof Uint8Array) && typeof source !== "function")
          throw new TypeError("Program source must provide Wasm bytes");
        executable = {
          adapter: program.adapter,
          interruptible: true,
          module: sourceModule(source, program.onLoad),
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
      physicalStops.set(owned, stop);
      return () => {
        // Disposal now owns this fence and stop, including releases from cancellation hooks.
        if (disposed) return;
        consumers.delete(owned);
        physicalStops.delete(owned);
      };
    },
    network() {
      if (disposed) return Promise.reject(new Error("Runtime is disposed"));
      if (networkActivation) return networkActivation;
      const canceled = new Error("Runtime is disposed");
      const checkNetworkOwner = () => {
        if (disposed) throw canceled;
      };
      const pending = import("./browser/net/runtime.js")
        .then(({ createRuntimeNetwork }) =>
          disposed
            ? undefined
            : createRuntimeNetwork(checkNetworkOwner, (guest, directory) =>
                filesystem.attachSocketScope(guest, directory),
              ),
        )
        .catch((error: unknown) => {
          if (error !== canceled) throw error;
          return undefined;
        });
      ownedNetwork = pending;
      networkActivation = pending.then((owner) => {
        assertLive();
        if (!owner) throw new Error("Runtime is disposed");
        return owner.network;
      });
      return networkActivation;
    },
    processes() {
      if (disposed) return Promise.reject(new Error("Runtime is disposed"));
      if (activation) return activation;
      const pendingHost = Promise.resolve().then(async (): Promise<BrowserProcessBroker> => {
        await programCollection.startup();
        const [activeRegistry, { ProcessTable }] = await Promise.all([
          getRegistry(),
          import("./proc/table.js"),
        ]);
        const table = new ProcessTable(identities);
        const hostOptions: BrowserProcessBrokerOptions = {
          hostIdentity,
          filesystem: {
            connect: (identity) => filesystem.connect(identity),
            revoke: (identity) => filesystem.revoke(identity),
            reap: (identity) => filesystem.reap(identity),
            quiesce: (identity) => filesystem.quiesce(identity),
            sweep: () => filesystem.client.sweep(),
          },
          identities,
          registry: activeRegistry,
          table,
          onProcessAdmission: options.onProcessAdmission,
          memoryGroups: options.memoryGroups,
          launchCommand: (context, capabilities) =>
            ownLaunch(async () => {
              const { runCommand } = await import("./proc/command-runner.js");
              assertLive();
              return runCommand(context, capabilities);
            }),
          launch: (context) => {
            assertLive();
            const launch = adapters.get(context.adapter);
            if (!launch) throw new Error(`Unknown adapter: ${context.adapter}`);
            return ownLaunch(() =>
              launch(
                { ...context, identity: createProcessIdentity(context, hostIdentity) },
                service!,
              ),
            );
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
      const programRemoval = programCollection.close();
      void programRemoval.catch(() => {});
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
        const stops = Array.from(physicalStops);
        const hostOwner = host;
        const hostStop = hostOwner?.dispose.bind(hostOwner);
        releaseTermination();
        const stopped = await Promise.allSettled(
          stops.map(([owner, stop]) => joinStop({ owner, stop, physicalStops, cleanupDebt })),
        );
        failures.push(...stopFailures(stopped));
        let network: RuntimeNetworkOwner | undefined;
        if (ownedNetwork) await attempt(async () => (network = await ownedNetwork));
        if (network) await attempt(() => network?.dispose());
        // Unsettled socket cleanup needs the filesystem: retain it like a failed physical stop.
        const networkFailed = network?.retained() ?? false;
        if (hostOwner && hostStop)
          await attempt(() =>
            joinStop({ owner: hostOwner, stop: hostStop, physicalStops, cleanupDebt }),
          );
        if (networkFailed || cleanupDebt.size) throwFailures();
        await attempt(() => programRemoval);
        consumers.clear();
        const failuresBeforeFilesystemClose = failures.length;
        await attempt(() => filesystem.dispose());
        if (failures.length !== failuresBeforeFilesystemClose) throwFailures();
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
  const programCollection = new ProgramCollection(
    runtime,
    {
      load: async (path) => {
        assertLive();
        return (await getRegistry()).resolve(path, "/", assertLive);
      },
      launchInterpreter: async (interpreter, context, service) => {
        const executable = await (await getRegistry()).check(interpreter);
        if ("command" in executable)
          throw new ExecutableFormatError("Registered script interpreters require a Wasm module");
        const launch = adapters.get(executable.adapter);
        if (!launch) throw new Error(`Unknown interpreter adapter: ${executable.adapter}`);
        return launch({ ...context, adapter: executable.adapter }, service);
      },
    },
    options.programs,
  );
  programCollection.initialize();
  return Object.freeze(runtime);
}

export type {
  RootDescendantPreparation,
  RootPreparationCompletion,
} from "./browser/process-broker.js";

function sharedPreparation(
  prepare: () => Promise<void>,
  onLoad: ProgramDefinition["onLoad"],
  assertLive: () => void,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    assertLive();
    onLoad?.({ kind: "preparing" });
    const attempt = Promise.resolve().then(prepare).then(assertLive);
    pending = attempt;
    void attempt.catch((error: unknown) => {
      if (pending === attempt) pending = undefined;
      onLoad?.({ kind: "error", error });
    });
    return attempt;
  };
}
