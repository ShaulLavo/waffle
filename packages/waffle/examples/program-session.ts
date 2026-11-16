import {
  createRuntime,
  type Runtime,
  type RuntimeOptions,
  type ProgramHandle,
  type RuntimeStartupStage,
} from "../index.js";

type Catalog =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      readonly programs: readonly ProgramHandle[];
    }
  | { readonly kind: "known"; readonly programs: readonly ProgramHandle[] };
type Preparation =
  | { readonly kind: "idle" | "preparing" | "loaded" }
  | { readonly kind: "failed"; readonly error: unknown };
export type ProgramSessionSnapshot =
  | { readonly kind: "closed" | "opening" | "closing" }
  | { readonly kind: "failed"; readonly error: unknown }
  | {
      readonly kind: "active";
      readonly filesystem: Runtime["filesystem"]["state"];
      readonly catalog: Catalog;
      readonly preparation: Preparation;
      readonly stage: RuntimeStartupStage | undefined;
    };

interface Session {
  readonly runtime: Runtime;
  catalog:
    | { readonly kind: "unknown" }
    | { readonly kind: "known" }
    | { readonly kind: "failed"; readonly error: unknown };
  preparation: Preparation;
  stage: RuntimeStartupStage | undefined;
}
type View = Exclude<ProgramSessionSnapshot, { readonly kind: "active" }> | Session;
export type SessionResult = "completed" | "superseded";

/** Copyable page-owner example, not an additional Waffle runtime API. */
export class ProgramSession {
  private generation = {};
  private owner: Runtime | undefined;
  private view: View = { kind: "closed" };
  private replacement = Promise.resolve();
  private work = Promise.resolve();

  snapshot(): ProgramSessionSnapshot {
    const view = this.view;
    if (!("runtime" in view)) return view;
    return {
      kind: "active",
      filesystem: view.runtime.filesystem.state,
      catalog:
        view.catalog.kind === "unknown"
          ? view.catalog
          : { ...view.catalog, programs: view.runtime.programs.status() },
      preparation: view.preparation,
      stage: view.stage,
    };
  }

  /** Terminal, agent and UI borrow this same runtime and its program collection. */
  runtime(): Runtime | undefined {
    return "runtime" in this.view ? this.view.runtime : undefined;
  }

  open(options: RuntimeOptions): Promise<SessionResult> {
    const generation = (this.generation = {});
    this.view = { kind: "opening" };
    // Keep a rejected disposal in this chain. Failure is not permission to replace an owner.
    this.replacement = this.replacement.then(async () => {
      await this.owner?.dispose();
      this.owner = undefined;
    });
    return this.finishOpen(options, generation);
  }

  private start(options: RuntimeOptions, generation: object): Session {
    let stage: RuntimeStartupStage | undefined;
    const runtime = createRuntime({
      ...options,
      filesystem: {
        ...options.filesystem,
        onStateChange: (state) => {
          if (this.generation === generation) return options.filesystem?.onStateChange?.(state);
        },
      },
      onStartupStage: (next, timestamp) => {
        if (this.generation !== generation) return;
        stage = next;
        if ("runtime" in this.view) this.view.stage = next;
        return options.onStartupStage?.(next, timestamp);
      },
    });
    this.owner = runtime;
    const session: Session = {
      runtime,
      catalog: { kind: "unknown" },
      preparation: { kind: "idle" },
      stage,
    };
    this.view = session;
    return session;
  }

  private async finishOpen(options: RuntimeOptions, generation: object): Promise<SessionResult> {
    try {
      await this.replacement;
      if (this.generation !== generation) return "superseded";
      const session = this.start(options, generation);
      await session.runtime.programs.ready;
      if (this.view !== session) return "superseded";
      session.catalog = { kind: "known" };
      return "completed";
    } catch (error) {
      if (this.generation !== generation) return "superseded";
      if ("runtime" in this.view) this.view.catalog = { kind: "failed", error };
      else this.view = { kind: "failed", error };
      throw error;
    }
  }

  preload(...targets: Parameters<Runtime["programs"]["preload"]>): Promise<SessionResult> {
    const pending = this.work.then(() => this.prepare(targets));
    this.work = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  private async prepare(
    targets: Parameters<Runtime["programs"]["preload"]>,
  ): Promise<SessionResult> {
    // Resolve the session at dequeue, rather than retaining the one at enqueue.
    const generation = this.generation;
    try {
      await this.replacement;
    } catch (error) {
      if (this.generation !== generation) return "superseded";
      throw error;
    }
    if (this.generation !== generation) return "superseded";
    const session = this.view;
    if (!("runtime" in session)) throw new Error("No active program session");
    session.preparation = { kind: "preparing" };
    try {
      await session.runtime.programs.preload(...targets);
      if (this.view !== session) return "superseded";
      session.preparation = { kind: "loaded" };
      return "completed";
    } catch (error) {
      if (this.view !== session) return "superseded";
      session.preparation = { kind: "failed", error };
      throw error;
    }
  }

  close(): Promise<void> {
    const generation = (this.generation = {});
    this.view = { kind: "closing" };
    this.replacement = this.replacement.then(async () => {
      await this.owner?.dispose();
      this.owner = undefined;
      if (this.generation === generation) this.view = { kind: "closed" };
    });
    return this.replacement.catch((error: unknown) => {
      if (this.generation === generation) this.view = { kind: "failed", error };
      throw error;
    });
  }
}
