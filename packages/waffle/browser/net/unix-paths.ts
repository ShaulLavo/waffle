// Owner-side pathname socket state: path checks, the per-helper filesystem scope seam, and the
// runtime-retained cleanup set. Loaded only with runtime.network().

import type { FileHandle, SocketBinding } from "../../core/filesystem.js";
import type { SocketKey } from "./namespace.js";
import {
  EADDRINUSE,
  EBADF,
  ECANCELED,
  EEXIST,
  EINVAL,
  ENAMETOOLONG,
  ENOENT,
  PATH_LIMIT,
} from "./unix-status.js";

const encoder = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The socket-only filesystem session admitted for one helper's scope. */
export interface AttachedSocketScope {
  readonly client: {
    asyncCall(operation: string, args: unknown[]): Promise<any>;
    dispose(): void;
  };
  readonly root: FileHandle;
  readonly rootIno: number;
}

/** WASI errno of a rejected filesystem call. */
export function errnoOf(error: unknown): number {
  if (error && typeof error === "object" && "errno" in error && typeof error.errno === "number")
    return error.errno;
  return ECANCELED;
}

/** A helper's view of its runtime's path state. */
export interface HelperPaths {
  readonly cleanup: PathCleanup;
  /** Attach the helper's scope on first use; a WASI errno when it has none or attach failed. */
  scope(): Promise<SocketScope | number>;
  /** The helper is gone. Its scope closes once retained cleanup no longer needs it. */
  retire(): void;
}

/** 0, or the WASI errno for a path that must not reach the filesystem walk. */
export function socketPathError(path: unknown): number {
  if (typeof path !== "string" || path.includes("\0") || LONE_SURROGATE.test(path)) return EINVAL;
  if (path === "") return ENOENT;
  // Bun joins relative paths to the process cwd; Waffle reads absolute paths inside the scope.
  if (!path.startsWith("/")) return EINVAL;
  if (encoder.encode(path).length > PATH_LIMIT) return ENAMETOOLONG;
  return 0;
}

/** One exact binding. Cleanup compares this lease, never the path string. */
export interface SocketLease {
  readonly key: SocketKey;
  /** The string the guest bound; reported as the listener's address. */
  readonly path: string;
}

/** A helper's authenticated filesystem scope. Every method answers with a WASI errno on failure. */
export interface SocketScope {
  /** Exclusively create a socket node; EADDRINUSE for any occupied name. */
  bind(path: string): Promise<SocketLease | number>;
  /** Walk to a socket, following a final symlink, and check write permission. */
  target(path: string): Promise<SocketKey | number>;
  /** Release the lease, removing its original edge only if `unlink` and the edge still names it.
   * 0 when settled; a lease whose edge moved or was replaced is settled without removal. */
  unbind(lease: SocketLease, unlink: boolean): Promise<number>;
  close(): Promise<void>;
}

interface Unbind {
  readonly scope: SocketScope;
  readonly lease: SocketLease;
  readonly unlink: boolean;
  failure?: unknown;
}

/**
 * Runtime-owned cleanup. Helper disposal is synchronous, so every unbind and scope close it starts
 * is retained here and joined by the runtime before filesystem destruction. A failed unbind keeps
 * its lease and its scope open until a later dispose retries it.
 */
/** Runtime-wide cap on admitted path requests that have not finished. */
const PATH_PENDING = 128;

export class PathCleanup {
  private pending = 0;
  private debt = new Set<Unbind>();
  private busy = new Map<SocketScope, number>();
  private work = new Set<Promise<unknown>>();
  private retired = new Set<SocketScope>();
  private closing = new Map<SocketScope, Promise<void>>();
  private failures: unknown[] = [];

  /** Admit one path request before any await; the returned release runs at most once. */
  admit(): (() => void) | undefined {
    if (this.pending >= PATH_PENDING) return undefined;
    this.pending++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.pending--;
    };
  }

  /** Keep an admitted path operation (bind, attach) joined by dispose. */
  track<T>(operation: Promise<T>): Promise<T> {
    this.work.add(operation);
    const forget = () => this.work.delete(operation);
    void operation.then(forget, forget);
    return operation;
  }

  /** Run scope work that may start an unbind; the scope stays open until it finishes. */
  use<T>(scope: SocketScope, operation: () => Promise<T>): Promise<T> {
    this.busy.set(scope, (this.busy.get(scope) ?? 0) + 1);
    const done = () => {
      const count = this.busy.get(scope)! - 1;
      if (count) this.busy.set(scope, count);
      else this.busy.delete(scope);
      this.closeIdle(scope);
    };
    return this.track(operation().finally(done));
  }

  unbind(scope: SocketScope, lease: SocketLease, unlink: boolean): Promise<number> {
    const entry: Unbind = { scope, lease, unlink };
    this.debt.add(entry);
    return this.track(this.attempt(entry));
  }

  /** The scope's helper is gone: close it once no retained lease needs it. */
  retire(scope: SocketScope): void {
    this.retired.add(scope);
    this.closeIdle(scope);
  }

  private async attempt(entry: Unbind): Promise<number> {
    let status: number;
    try {
      status = await entry.scope.unbind(entry.lease, entry.unlink);
    } catch (error) {
      entry.failure = error;
      return ECANCELED;
    }
    if (status !== 0) {
      entry.failure = new Error(`Socket unbind failed with errno ${status}`);
      return status;
    }
    this.debt.delete(entry);
    this.closeIdle(entry.scope);
    return 0;
  }

  private closeIdle(scope: SocketScope): void {
    if (!this.retired.has(scope) || this.closing.has(scope) || this.busy.has(scope)) return;
    for (const entry of this.debt) if (entry.scope === scope) return;
    const closed = scope.close().then(
      () => {
        this.retired.delete(scope);
        this.closing.delete(scope);
      },
      (error: unknown) => {
        this.closing.delete(scope);
        this.failures.push(error);
      },
    );
    this.closing.set(scope, closed);
    this.track(closed);
  }

  /** True while any lease, scope or admitted operation still needs the filesystem. */
  retained(): boolean {
    return this.debt.size > 0 || this.retired.size > 0 || this.work.size > 0;
  }

  /** Join all admitted work, retry each failed unbind once, close retired scopes. Failures stay
   * retained for the next call and reject as one AggregateError. */
  async dispose(): Promise<void> {
    while (this.work.size) await Promise.allSettled(Array.from(this.work));
    const failed = Array.from(this.debt).filter((entry) => entry.failure !== undefined);
    for (const entry of failed) entry.failure = undefined;
    await Promise.allSettled(failed.map((entry) => this.track(this.attempt(entry))));
    for (const scope of this.retired) this.closeIdle(scope);
    while (this.work.size) await Promise.allSettled(Array.from(this.work));
    const failures = this.failures.concat(
      Array.from(this.debt, (entry) => entry.failure ?? new Error("Socket unbind is unsettled")),
    );
    this.failures = [];
    if (failures.length) throw new AggregateError(failures, "Socket cleanup failed");
  }
}

interface Binding {
  readonly binding: SocketBinding;
  readonly name: string;
  readonly lease: number;
}

/** Scope over the filesystem's socket session. Leases name the original parent edge, so cleanup
 * never re-resolves the path the guest passed. */
export function filesystemScope({ client, root, rootIno }: AttachedSocketScope): SocketScope {
  const bindings = new WeakMap<SocketLease, Binding>();
  let nextLease = 1;
  return {
    async bind(path) {
      const lease = nextLease++;
      const result: { binding: SocketBinding; name: string } | { error: number } =
        await client.asyncCall("bindSocketPath", [root, path, lease]);
      if ("error" in result) return result.error === EEXIST ? EADDRINUSE : result.error;
      const socket: SocketLease = Object.freeze({
        key: Object.freeze({ rootIno, ino: result.binding.ino }),
        path,
      });
      bindings.set(socket, { binding: result.binding, name: result.name, lease });
      return socket;
    },
    async target(path) {
      const result: { ino: number } | { error: number } = await client.asyncCall("connectSocket", [
        root,
        path,
      ]);
      return "error" in result ? result.error : { rootIno, ino: result.ino };
    },
    async unbind(socket, unlink) {
      const entry = bindings.get(socket);
      if (!entry) return EBADF;
      const status: number = await client.asyncCall("unbindSocket", [
        entry.binding,
        entry.name,
        entry.lease,
        unlink,
      ]);
      // ENOENT: the original edge no longer names this lease (moved or replaced). Settled.
      return status === ENOENT ? 0 : status;
    },
    async close() {
      client.dispose();
    },
  };
}
