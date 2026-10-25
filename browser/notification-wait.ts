import type { FilesystemClient } from "../fs/client.js";
import type { ProcessABI, PollSubscription } from "../proc/abi.js";
import type { NetHost } from "./net/host.js";
import type {
  NotificationConnection,
  NotificationRelayReply,
  NotificationRelayRequest,
  NotificationWord,
} from "./notification-relay.js";
import {
  atomicsAdd,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  atomicsWait,
  atomicsWaitAsync,
  Int32ArrayConstructor,
  reflectApply,
  typedArrayBuffer,
  typedArrayByteOffset,
} from "../proc/intrinsics.js";

const now = performance.now.bind(performance);
const maximum = Math.max;
const minimum = Math.min;
const post = MessagePort.prototype.postMessage;
const close = MessagePort.prototype.close;

export interface NotificationSample {
  readonly sequence: number;
  readonly filesystem: number;
  readonly network: number | undefined;
  readonly process: number | undefined;
}

export type NotificationWaitResult = "ok" | "not-equal" | "timed-out" | "closed";

export interface NotificationWaitSet {
  readonly covered: boolean;
  readonly disposed: boolean;
  sample(): NotificationSample;
  wait(observed: NotificationSample, deadline: number): NotificationWaitResult;
  setProcessSubscriptions(subscriptions: readonly PollSubscription[]): void;
  dispose(): void;
}

export interface NotificationSources {
  readonly network?: NetHost;
  readonly process?: ProcessABI;
  readonly subscriptions?: readonly PollSubscription[];
}

function word(cells: Int32Array, index = 0): NotificationWord {
  return { cells, index };
}

function generation(source: NotificationWord | undefined): number | undefined {
  return source ? atomicsLoad(source.cells, source.index) : undefined;
}

function filesystemWord(fs: FilesystemClient): NotificationWord {
  return word(fs.shared.watch.cells, 3);
}

function sequenceView(state: Int32Array): Int32Array {
  return new Int32ArrayConstructor(typedArrayBuffer(state), typedArrayByteOffset(state), 1);
}

/** One bridge and one wait set per guest. The broker owns its external lifetime. */
export class NotificationWaitScope {
  private status: "open" | "arming" | "armed" | "closed" = "open";
  private detachNetwork: (() => void) | undefined;
  private readonly wake: Int32Array;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private rejectArm: ((error: Error) => void) | undefined;
  private cleanupError: { error: unknown } | undefined;
  private readonly send: (request: NotificationRelayRequest) => void;

  constructor(
    private readonly connection: NotificationConnection,
    private readonly fs: FilesystemClient,
  ) {
    this.wake = sequenceView(connection.state);
    this.send = (request) => reflectApply(post, connection.port, [request]);
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    void this.observeLifetime();
  }

  get closed(): Promise<void> {
    return this.closedPromise;
  }

  private async observeLifetime(): Promise<void> {
    while (this.status !== "closed") {
      const seen = atomicsLoad(this.wake, 0);
      if (atomicsLoad(this.connection.state, 1)) break;
      const waiting = atomicsWaitAsync(this.wake, 0, seen);
      if (waiting.async) await waiting.value;
    }
    try {
      this.dispose();
    } catch {
      /* The disposing owner receives the retained cleanup error. */
    }
  }

  async arm(sources: NotificationSources = {}): Promise<NotificationWaitSet> {
    if (this.status !== "open") throw new Error("notification scope is not open");
    this.status = "arming";
    try {
      const filesystem = filesystemWord(this.fs);
      const network = sources.network ? word(sources.network.notification) : undefined;
      const registration = sources.process?.registerPoll(sources.subscriptions ?? [], "shared");
      const process = registration?.wake ? word(registration.wake) : undefined;
      const words = [filesystem];
      if (network) words.push(network);
      if (process) words.push(process);
      this.detachNetwork = sources.network?.registerNotificationSink(this.wake);
      await this.armRelay(words);
      if (atomicsLoad(this.connection.state, 1))
        throw new Error("notification scope closed during arming");
      this.status = "armed";
      return this.waitSet(
        filesystem,
        network,
        process,
        sources,
        registration?.covered ?? !sources.process,
      );
    } catch (error) {
      try {
        this.dispose();
      } catch {
        /* Preserve the startup error; dispose retains its own error. */
      }
      throw error;
    }
  }

  private armRelay(words: readonly NotificationWord[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.rejectArm = reject;
      this.connection.port.onmessage = ({ data }: MessageEvent<NotificationRelayReply>) => {
        this.rejectArm = undefined;
        if (data.type === "error") reject(new Error(data.message));
        else resolve();
      };
      this.send({ type: "arm", words });
    });
  }

  private waitSet(
    filesystem: NotificationWord,
    network: NotificationWord | undefined,
    process: NotificationWord | undefined,
    sources: NotificationSources,
    initialCoverage: boolean,
  ): NotificationWaitSet {
    let covered = initialCoverage;
    const disposed = () => this.status === "closed" || atomicsLoad(this.connection.state, 1) !== 0;
    const sample = (): NotificationSample => ({
      sequence: atomicsLoad(this.wake, 0),
      filesystem: atomicsLoad(filesystem.cells, filesystem.index),
      network: generation(network),
      process: generation(process),
    });
    return {
      get covered() {
        return covered;
      },
      get disposed() {
        return disposed();
      },
      sample,
      wait: (observed, deadline) => {
        if (disposed()) return "closed";
        const current = sample();
        if (changed(observed, current)) return "not-equal";
        const remaining = deadline === Infinity ? Infinity : maximum(0, deadline - now());
        if (remaining === 0) return "timed-out";
        const result = atomicsWait(
          this.wake,
          0,
          observed.sequence,
          covered ? remaining : minimum(remaining, 10),
        );
        return disposed() ? "closed" : result;
      },
      setProcessSubscriptions(subscriptions) {
        covered =
          sources.process?.registerPoll(subscriptions, "shared").covered ??
          subscriptions.length === 0;
      },
      dispose: () => this.dispose(),
    };
  }

  dispose(): void {
    if (this.status === "closed") {
      if (this.cleanupError) throw this.cleanupError.error;
      return;
    }
    this.status = "closed";
    const detach = this.detachNetwork;
    const reject = this.rejectArm;
    this.detachNetwork = undefined;
    this.rejectArm = undefined;
    const steps = [
      () => atomicsStore(this.connection.state, 1, 1),
      () => detach?.(),
      () => reject?.(new Error("notification scope closed during arming")),
      () => this.send({ type: "dispose" }),
      () => reflectApply(close, this.connection.port, []),
      () => atomicsAdd(this.wake, 0, 1),
      () => atomicsNotify(this.wake, 0),
      () => this.resolveClosed(),
    ];
    for (const step of steps) this.cleanupStep(step);
    if (this.cleanupError) throw this.cleanupError.error;
  }

  private cleanupStep(step: () => unknown): void {
    try {
      step();
    } catch (error) {
      this.cleanupError ??= { error };
    }
  }
}

function changed(before: NotificationSample, after: NotificationSample): boolean {
  return (
    before.sequence !== after.sequence ||
    before.filesystem !== after.filesystem ||
    before.network !== after.network ||
    before.process !== after.process
  );
}
