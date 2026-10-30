import type { GuestLauncher, ProgramLoadState, Runtime } from "../runtime.js";
import {
  installPrograms,
  ProgramConflictError,
  type PackageProgram,
  type ProgramInstallation,
  type ProgramPackage,
} from "./index.js";
import { matchesProgram, packageIdentity } from "./catalog.js";

export type ProgramMode = "onDemand" | "preload";
export type ProgramState = ProgramLoadState | { readonly kind: "removed" };
export interface ProgramHandle {
  readonly name: string;
  readonly path: string;
  readonly aliases: readonly string[];
  readonly mode: ProgramMode;
  readonly state: ProgramState;
  preload(): Promise<void>;
  remove(): Promise<void>;
}
export interface ProgramsOptions {
  readonly preload?: readonly ProgramPackage[];
  readonly onDemand?: readonly ProgramPackage[];
  readonly launcher?: GuestLauncher;
}
export interface RuntimePrograms extends Iterable<ProgramHandle> {
  readonly ready: Promise<void>;
  onDemand(...packages: ProgramPackage[]): Promise<void>;
  preload(...targets: (ProgramPackage | string)[]): Promise<void>;
  get(name: string): ProgramHandle | undefined;
  status(): readonly ProgramHandle[];
  forEach(callback: (program: ProgramHandle) => void): void;
}
interface Member {
  readonly admission: AbortController;
  readonly package: ProgramPackage;
  readonly program: PackageProgram;
  readonly handle: ProgramHandle;
  mode: ProgramMode;
  state: ProgramState;
  installation?: ProgramInstallation;
  installing?: Promise<ProgramInstallation>;
  removal?: Promise<void>;
}
interface PackageOwner {
  readonly identity: object;
  kind: "active" | "retiring";
  readonly members: Set<Member>;
  readonly dispose: ProgramPackage["dispose"];
}
interface ProgramHost {
  load(path: string): Promise<unknown>;
  launchInterpreter: NonNullable<Parameters<typeof installPrograms>[2]["launchInterpreter"]>;
}

/** Page-owned metadata and installation lifetimes. Module promises remain in the registry. */
export class ProgramCollection implements RuntimePrograms {
  readonly view: RuntimePrograms;
  ready: Promise<void> = Promise.resolve();
  private registration: Promise<void> = Promise.resolve();
  private startupRegistration: Promise<void> = Promise.resolve();
  private readonly members = new Map<string, Member>();
  private readonly owners = new Map<string, PackageOwner>();
  private closed = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly host: ProgramHost,
    private readonly options: ProgramsOptions = {},
  ) {
    this.view = programView(this);
  }

  initialize(): void {
    const onDemand = this.options.onDemand ?? [];
    const preload = this.options.preload ?? [];
    if (!onDemand.length && !preload.length) return;
    this.startupRegistration = this.enqueue(onDemand.concat(preload));
    this.ready = this.startupRegistration.then(async () => {
      const selected = new Set<Member>();
      for (const pkg of preload) this.select(pkg, selected);
      await Promise.all(Array.from(selected, (member) => this.load(member)));
    });
    void this.ready.catch(() => {});
  }

  startup(): Promise<void> {
    return this.startupRegistration;
  }

  onDemand(...packages: ProgramPackage[]): Promise<void> {
    return this.enqueue(packages).then(() => {
      const selected = new Set<Member>();
      for (const pkg of packages) this.select(pkg, selected);
      for (const member of selected) member.mode = "onDemand";
    });
  }

  async preload(...targets: (ProgramPackage | string)[]): Promise<void> {
    const packages = targets.filter(
      (target): target is ProgramPackage => typeof target !== "string",
    );
    await this.enqueue(packages);
    const selected = new Set<Member>();
    for (const target of targets) this.select(target, selected);
    await Promise.all(Array.from(selected, (member) => this.load(member)));
  }

  get(name: string): ProgramHandle | undefined {
    return this.find(name)?.handle;
  }

  status(): readonly ProgramHandle[] {
    return Array.from(this.members.values(), (member) => member.handle);
  }
  [Symbol.iterator](): Iterator<ProgramHandle> {
    return this.status()[Symbol.iterator]();
  }
  forEach(callback: (program: ProgramHandle) => void): void {
    this.status().forEach(callback);
  }

  close(): Promise<void> {
    this.closed = true;
    const removals = Array.from(this.members.values(), (member) => this.remove(member));
    return Promise.allSettled(removals).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Program removal failed");
    });
  }

  private assertLive(): void {
    if (this.closed || this.runtime.disposed) throw new Error("Runtime is disposed");
  }

  private enqueue(packages: readonly ProgramPackage[]): Promise<void> {
    this.assertLive();
    const pending = this.registration.then(() => this.add(packages));
    this.registration = pending.catch(() => {});
    return pending;
  }

  private find(name: string): Member | undefined {
    const direct = this.members.get(name);
    if (direct) return direct;
    for (const member of this.members.values())
      if (matchesProgram(member.program, name)) return member;
    return undefined;
  }

  private select(target: ProgramPackage | string, selected: Set<Member>): void {
    if (typeof target !== "string") {
      for (const program of target.programs) {
        const member = this.members.get(program.path);
        if (member) selected.add(member);
      }
      return;
    }
    const member = this.find(target);
    if (!member) throw new Error(`Program is not installed: ${target}`);
    selected.add(member);
  }

  private async add(packages: readonly ProgramPackage[]): Promise<void> {
    this.assertLive();
    const fresh = this.plan(packages);
    try {
      for (const member of fresh) {
        await this.install(member);
      }
    } catch (error) {
      await Promise.allSettled(fresh.map((member) => this.remove(member)));
      throw error;
    }
  }

  private plan(packages: readonly ProgramPackage[]): Member[] {
    const fresh: Member[] = [];
    const claimed = new Map<string, Member>();
    for (const pkg of packages) this.planPackage(pkg, fresh, claimed);
    for (const member of fresh) {
      this.members.set(member.program.path, member);
      const owner = this.owners.get(member.package.name) ?? {
        identity: packageIdentity(member.package),
        kind: "active",
        members: new Set<Member>(),
        dispose: member.package.dispose,
      };
      owner.members.add(member);
      this.owners.set(member.package.name, owner);
    }
    return fresh;
  }

  private planPackage(
    pkg: ProgramPackage,
    fresh: Member[],
    claimed: Map<string, Member>,
    selection = pkg.programs,
  ): void {
    if (!selection.length) return;
    if (pkg.packages) {
      for (const family of pkg.packages)
        this.planPackage(
          family,
          fresh,
          claimed,
          family.programs.filter((program) => selection.includes(program)),
        );
      return;
    }
    const staged = fresh.find((member) => member.package.name === pkg.name);
    if (staged && packageIdentity(staged.package) !== packageIdentity(pkg))
      throw new ProgramConflictError(pkg.name, "different package identity");
    const owner = this.owners.get(pkg.name);
    if (owner && (owner.identity !== packageIdentity(pkg) || owner.kind === "retiring"))
      throw new ProgramConflictError(pkg.name, "different package owner");
    for (const program of selection) this.planProgram(pkg, program, fresh, claimed);
  }

  private planProgram(
    pkg: ProgramPackage,
    program: PackageProgram,
    fresh: Member[],
    claimed: Map<string, Member>,
  ): void {
    const existing = claimed.get(program.path) ?? this.members.get(program.path);
    if (existing?.program === program && existing.package.name === pkg.name && !existing.removal)
      return;
    const paths = [program.path].concat(program.aliases ?? []);
    for (const path of paths) {
      if (claimed.has(path) || this.find(path))
        throw new ProgramConflictError(path, "different or retiring program already owns it");
    }
    const member = this.member(pkg, program);
    for (const path of paths) claimed.set(path, member);
    fresh.push(member);
  }

  private member(pkg: ProgramPackage, program: PackageProgram): Member {
    const member: Member = {
      admission: new AbortController(),
      package: pkg,
      program,
      mode: "onDemand",
      state: { kind: "registered" },
      handle: Object.freeze({
        name: program.path.slice(program.path.lastIndexOf("/") + 1),
        path: program.path,
        aliases: Object.freeze((program.aliases ?? []).slice()),
        get mode() {
          return member.mode;
        },
        get state() {
          return member.state;
        },
        preload: () => this.load(member),
        remove: () => this.remove(member),
      }),
    };
    return member;
  }

  private async install(member: Member): Promise<void> {
    this.assertLive();
    if (member.removal) return;
    member.installing = installPrograms(
      this.runtime,
      [{ name: member.package.name, programs: [member.program] }],
      {
        signal: member.admission.signal,
        launcher: this.options.launcher ?? preview1Launcher,
        launchInterpreter: this.host.launchInterpreter,
        onLoad: (_program, state) => {
          if (!member.removal) member.state = Object.freeze(state);
        },
      },
    );
    member.installation = await member.installing;
    if (this.closed || member.removal) await member.installation.dispose();
  }

  private async load(member: Member): Promise<void> {
    this.assertLive();
    if (member.removal || this.members.get(member.program.path) !== member)
      throw new Error("Program was removed");
    member.mode = "preload";
    await this.registration;
    try {
      await this.host.load(member.program.path);
      if (member.removal) throw new Error("Program was removed");
    } catch (error) {
      if (!member.removal) member.state = Object.freeze({ kind: "error", error });
      throw error;
    }
  }

  private remove(member: Member): Promise<void> {
    if (member.removal) return member.removal;
    member.admission.abort();
    member.state = Object.freeze({ kind: "removed" });
    member.removal = this.retire(member);
    return member.removal;
  }

  private async retire(member: Member): Promise<void> {
    // Calling dispose before yielding closes admission synchronously for installed members.
    const disposal = member.installation?.dispose();
    await disposal;
    const installation = await member.installing?.catch(() => undefined);
    await installation?.dispose();
    const owner = this.owners.get(member.package.name);
    owner?.members.delete(member);
    if (owner && !owner.members.size) {
      owner.kind = "retiring";
      await owner.dispose?.();
      this.owners.delete(member.package.name);
    }
    if (this.members.get(member.program.path) === member) this.members.delete(member.program.path);
  }
}

const preview1Launcher: GuestLauncher = (context, service) =>
  service.launchWorker(context, {
    workerUrl: new URL("../browser/preview1-worker.ts", import.meta.url).href,
    request: {
      module: context.module,
      args: context.request.argv,
      env: context.request.env,
      interruptible: context.interruptible,
    },
  });

function programView(owner: ProgramCollection): RuntimePrograms {
  return Object.freeze({
    get ready() {
      return owner.ready;
    },
    onDemand: (...packages: ProgramPackage[]) => owner.onDemand(...packages),
    preload: (...targets: (ProgramPackage | string)[]) => owner.preload(...targets),
    get: (name: string) => owner.get(name),
    status: () => owner.status(),
    forEach: (callback: (program: ProgramHandle) => void) => owner.forEach(callback),
    [Symbol.iterator]: () => owner[Symbol.iterator](),
  });
}
