import {
  accepted,
  observed,
  greeting,
  beginRecovery,
  acceptRecovery,
  accepts,
  unsettled,
  IntentLedger,
  type AuthorityState,
} from "./recovery.js";
import { readRegistry } from "./database.js";
import {
  failure,
  type Arm,
  type Command,
  type Cursor,
  type Operation,
  type Reply,
  type Request,
  type WorkerMessage,
} from "./protocol.js";

class RecoveryAttempt {
  readonly id = crypto.randomUUID();
  readonly controller = new AbortController();
  readonly timer = setTimeout(
    () => this.controller.abort(new Error("UNAVAILABLE: recovery deadline")),
    3000,
  );
  finish(): void {
    clearTimeout(this.timer);
  }
  cancel(): void {
    this.controller.abort(new Error("FENCED: attempt superseded or detached"));
  }
}
export class ProofClient {
  readonly client = crypto.randomUUID();
  sequence = 0;
  nudges = 0;
  readonly faults: string[] = [];
  readonly observations: unknown[] = [];
  private observe(event: unknown): void {
    if (!new URL(location.href).searchParams.has("trace")) return;
    const value = { client: this.client, time: performance.now(), event };
    this.observations.push(value);
    if (this.observations.length > 256) this.observations.shift();
    console.info("E5_LIFECYCLE " + JSON.stringify(value));
  }
  cursor: Cursor = { epoch: 0, history: "", generation: 0, watermark: 0, durableWatermark: 0 };
  worker: SharedWorker | undefined;
  private messages = 0;
  authority: AuthorityState = { kind: "detached" };
  readonly intents = new IntentLedger();
  readonly recoveryEvents: unknown[] = [];
  staleReplies = 0;
  private attempt: RecoveryAttempt | undefined;
  private connection: { workspace: string; arm: Arm; token: string } | undefined;
  private pending = new Map<
    number,
    { instance: string | undefined; command: Command; settle: (reply: Reply) => void }
  >();
  private async runAttempt(work: (attempt: RecoveryAttempt) => Promise<Reply>): Promise<Reply> {
    this.attempt?.cancel();
    const attempt = new RecoveryAttempt();
    this.attempt = attempt;
    try {
      return await work(attempt);
    } catch (error) {
      if (this.attempt === attempt && this.authority.kind !== "detached")
        this.authority = {
          kind: "unavailable",
          instance: observed(this.authority),
          previous: accepted(this.authority),
          reason: String(error),
        };
      return failure(error);
    } finally {
      attempt.finish();
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }
  async recover(): Promise<Reply> {
    const connection = this.connection;
    if (!connection || !this.worker) return failure(new Error("UNAVAILABLE: no retained port"));
    return this.runAttempt((attempt) =>
      navigator.locks.request(
        `e5-bootstrap:${connection.workspace}`,
        { signal: attempt.controller.signal },
        () => this.recoverRetained(connection, attempt),
      ),
    );
  }
  private async recoverRetained(
    connection: {
      workspace: string;
      arm: Arm;
      token: string;
    },
    attempt: RecoveryAttempt,
  ): Promise<Reply> {
    this.validateAttempt(attempt);
    if (this.connection !== connection || !this.worker)
      return failure(new Error("FENCED: recovery attachment changed before admission"));
    const previous = accepted(this.authority);
    const worker = this.worker;
    const expectedInstance = observed(this.authority);
    this.authority = beginRecovery(this.authority);
    const head = await readRegistry(connection.workspace, attempt.controller.signal);
    this.validateRecovery(connection, worker, attempt, expectedInstance);
    const claimedInstance = observed(this.authority);
    const reply = await this.send(
      {
        kind: "initialize",
        ...connection,
        expected: head?.epoch ?? 0,
        attempt: attempt.id,
      },
      3000,
      attempt.controller.signal,
    );
    this.validateRecovery(connection, worker, attempt, claimedInstance);
    const instance = observed(this.authority);
    if (reply.kind === "error" || !instance) {
      this.authority = {
        kind: "unavailable",
        instance,
        previous,
        reason: reply.kind === "error" ? reply.message : "missing instance",
      };
      return reply;
    }
    this.authority = acceptRecovery(this.authority, {
      instance,
      token: connection.token,
      cursor: reply.cursor,
    });
    this.cursor = reply.cursor;
    const report = {
      kind: "recovered",
      instance,
      previous,
      current: reply.cursor,
      historyGap: Boolean(previous && previous.cursor.history !== reply.cursor.history),
      possibleAcknowledgedLoss:
        connection.arm === "volatile-fast" && Boolean(previous && previous.instance !== instance),
      unresolved: this.intents.unresolved(),
      replayed: 0,
    };
    this.recoveryEvents.push(report);
    if (this.recoveryEvents.length > 32) this.recoveryEvents.shift();
    return { ...reply, result: report };
  }
  private validateRecovery(
    connection: { workspace: string; arm: Arm; token: string },
    worker: SharedWorker | undefined,
    attempt: RecoveryAttempt,
    instance: string | undefined,
  ): void {
    this.validateAttempt(attempt);
    if (this.connection !== connection || this.worker !== worker)
      throw new Error("FENCED: recovery attachment changed");
    if (this.authority.kind !== "recovering" || (instance && observed(this.authority) !== instance))
      throw new Error("FENCED: recovery instance changed across await");
  }
  private validateAttempt(attempt: RecoveryAttempt): void {
    attempt.controller.signal.throwIfAborted();
    if (this.attempt !== attempt) throw new Error("FENCED: obsolete recovery attempt");
  }
  async connect(workspace: string, arm: Arm, replace = false): Promise<Reply> {
    return this.runAttempt((attempt) =>
      navigator.locks.request(
        `e5-bootstrap:${workspace}`,
        { signal: attempt.controller.signal },
        () => this.attach(workspace, arm, replace, attempt),
      ),
    );
  }
  private async attach(
    workspace: string,
    arm: Arm,
    replace: boolean,
    attempt: RecoveryAttempt,
  ): Promise<Reply> {
    this.validateAttempt(attempt);
    const head = await readRegistry(workspace, attempt.controller.signal);
    this.validateAttempt(attempt);
    const token = !replace && head && !head.closed ? head.token : crypto.randomUUID();
    this.detachAttachment();
    this.connection = { workspace, arm, token };
    this.authority = beginRecovery(this.authority);
    const trace = new URL(location.href).searchParams.has("trace") ? "&trace=1" : "";
    this.observe({ phase: "attach", workspace, token });
    const worker = new SharedWorker(`/authority.js?workspace=${workspace}&token=${token}${trace}`, {
      name: token,
      type: "module",
    });
    this.worker = worker;
    worker.onerror = (event) => this.fault(`worker error: ${event.message}`);
    worker.port.onmessageerror = () => this.fault("port messageerror");
    worker.port.onmessage = (event) => {
      if (this.worker === worker) this.receive(event.data);
      else this.staleReplies++;
    };
    worker.port.start();
    return this.recoverRetained(this.connection, attempt);
  }

  private fault(message: string): void {
    this.observe({ phase: "fault", message });
    this.faults.push(message);
    if (this.faults.length > 32) this.faults.shift();
  }
  private receive(value: WorkerMessage): void {
    if ("hello" in value) {
      const previous = observed(this.authority);
      this.authority = greeting(this.authority, value.hello);
      if (previous && previous !== value.hello) this.invalidatePending("worker instance replaced");
      this.observe({ phase: "hello", instance: value.hello, state: this.authority.kind });
      return;
    }
    if (value.diagnostic) {
      this.observe(value.diagnostic);
      return;
    }
    if (value.nudge) {
      if (this.authority.kind === "current" && observed(this.authority) === value.instance)
        this.nudges++;
      return;
    }
    if (value.id === undefined || !value.result) return;
    const pending = this.pending.get(value.id);
    if (!pending || (pending.instance && pending.instance !== value.instance)) {
      this.staleReplies++;
      return;
    }
    if (
      pending.command.kind === "request" &&
      !accepts(this.authority, value.instance, value.result)
    ) {
      pending.settle(unsettled(pending.command.request, "obsolete authority response"));
      return;
    }
    pending.settle(value.result);
  }
  private invalidatePending(reason: string): void {
    for (const pending of this.pending.values())
      pending.settle(
        unsettled(pending.command.kind === "request" ? pending.command.request : undefined, reason),
      );
  }
  send(command: Command, timeoutMs = 3000, signal?: AbortSignal): Promise<Reply> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(failure(new Error("UNAVAILABLE: disconnected")));
    if (signal?.aborted) return Promise.resolve(failure(signal.reason));
    if (command.kind === "request" && this.authority.kind !== "current")
      return Promise.resolve(unsettled(command.request, `authority ${this.authority.kind}`));
    if (this.pending.size >= 64)
      return Promise.resolve(failure(new Error("BACKPRESSURE: client pending budget")));
    const id = ++this.messages;
    this.observe({ phase: "send", id, command });
    return new Promise((resolve) => {
      const settle = (reply: Reply) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.pending.delete(id);
        resolve(reply);
      };
      const cancel = () => {
        if (command.kind === "initialize")
          worker.port.postMessage({
            id,
            command: { kind: "cancel-initialize", attempt: command.attempt },
          });
      };
      const aborted = () => {
        cancel();
        settle(unsettled(undefined, "initialization interrupted"));
      };
      const timer = setTimeout(() => {
        cancel();
        this.fault(`response deadline: ${command.kind}`);
        settle(
          unsettled(command.kind === "request" ? command.request : undefined, "response deadline"),
        );
      }, timeoutMs);
      this.pending.set(id, { instance: observed(this.authority), command, settle });
      signal?.addEventListener("abort", aborted, { once: true });
      worker.port.postMessage({ id, command });
    });
  }
  request(operation: Operation, options: Partial<Request> = {}): Request {
    return {
      client: `${this.cursor.history}/${this.client}`,
      sequence: ++this.sequence,
      epoch: this.cursor.epoch,
      history: this.cursor.history,
      actor: "host",
      operation,
      ...options,
    };
  }
  async execute(operation: Operation, options: Partial<Request> = {}): Promise<Reply> {
    return this.submit(this.request(operation, options));
  }
  async submit(request: Request): Promise<Reply> {
    if (this.authority.kind !== "current")
      return unsettled(undefined, `authority ${this.authority.kind}; not admitted`);
    if (this.pending.size >= 64) return failure(new Error("BACKPRESSURE: client pending budget"));
    let owned: Request;
    try {
      owned = this.intents.capture(request);
    } catch (error) {
      return failure(error);
    }
    const instance = observed(this.authority);
    const received = await this.send({ kind: "request", request: owned });
    const reply =
      received.kind === "ok" && (!instance || !accepts(this.authority, instance, received))
        ? unsettled(owned, "authority changed across submit await")
        : received;
    this.intents.settle(owned, reply);
    if (reply.kind === "ok" && this.authority.kind === "current") {
      this.cursor = reply.cursor;
      this.authority = {
        kind: "current",
        accepted: { ...this.authority.accepted, cursor: reply.cursor },
      };
    }
    return reply;
  }
  detach(): void {
    this.attempt?.cancel();
    this.attempt = undefined;
    this.detachAttachment();
  }
  private detachAttachment(): void {
    this.observe({ phase: "detach", hadWorker: Boolean(this.worker) });
    this.invalidatePending("port detached");
    this.worker?.port.close();
    this.worker = undefined;
    this.connection = undefined;
    this.authority = { kind: "detached" };
  }
}

export async function runGuest(client: ProofClient, path: string, value: string): Promise<unknown> {
  const shared = new SharedArrayBuffer(131072);
  const cells = new Int32Array(shared, 0, 4);
  const bytes = new Uint8Array(shared, 16);
  const worker = new Worker("/guest.js", { type: "module" });
  const encoder = new TextEncoder();
  const completion = Promise.withResolvers<unknown>();
  const timer = setTimeout(() => {
    worker.terminate();
    completion.reject(new Error("Guest deadline"));
  }, 15000);
  worker.onmessage = async (event) => {
    if (event.data.kind !== "syscall") {
      clearTimeout(timer);
      worker.terminate();
      completion.resolve(event.data);
      return;
    }
    const operation: Operation = event.data.operation;
    const reply = await client.execute(operation, { actor: "guest" }).catch(failure);
    const encoded = encoder.encode(JSON.stringify(reply));
    if (encoded.length > bytes.length) {
      worker.terminate();
      clearTimeout(timer);
      completion.reject(new Error("BACKPRESSURE: guest response budget"));
      return;
    }
    bytes.set(encoded);
    Atomics.store(cells, 1, encoded.length);
    Atomics.store(cells, 0, 1);
    Atomics.notify(cells, 0);
  };
  worker.onerror = (event) => {
    clearTimeout(timer);
    worker.terminate();
    completion.reject(new Error(event.message));
  };
  worker.postMessage({ shared, path, value });
  return completion.promise;
}
