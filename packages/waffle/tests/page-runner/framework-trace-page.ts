import type { FrameworkTraceDocument } from "./framework-page.js";
import { resultByteLimit } from "./protocol.js";

const descriptor = Object.getOwnPropertyDescriptor;
const apply = Reflect.apply;
const stringify = JSON.stringify;
const withoutPrototype = Object.setPrototypeOf;
const encode = TextEncoder.prototype.encode;
const Encoder = TextEncoder;
const parse = JSON.parse;
const deferred = Promise.withResolvers.bind(Promise);
const resolved = Promise.resolve.bind(Promise);
type Role = "orchestrator" | "tester";
type Match = { readonly iframeId: string; readonly messageId: number };
type Binding = Parameters<Extract<FrameworkTraceDocument, { kind: "tester" }>["bind"]>[0];
type PageTransport = {
  post(body: object): Promise<void>;
  receipt(body: object): void;
  closeEvidence(): Promise<void>;
  authorization: Promise<string>;
};
function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return;
  const field = descriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}
function message(value: unknown): (Match & { readonly event: string }) | undefined {
  const event = own(value, "event"),
    iframeId = own(value, "iframeId"),
    messageId = own(value, "messageId");
  if (
    typeof event !== "string" ||
    typeof iframeId !== "string" ||
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId)
  )
    return;
  return { event, iframeId, messageId };
}

/** Private page state; transport injection is a CPU seam, never a provider operation. */
export class FrameworkTracePageOwner {
  private binding: Binding | undefined;
  private transport: PageTransport | undefined;
  private generation: string | undefined;
  private iframeId: string | undefined;
  private match: Match | undefined;
  private responseMatched = false;
  private failed = false;
  private observing = false;
  private snapshotting = false;
  private text: string | undefined;
  private quiet = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly addPending = this.pending.add.bind(this.pending);
  private readonly deletePending = this.pending.delete.bind(this.pending);
  private readonly pendingValues = this.pending.values.bind(this.pending);
  private readonly pulse = resolved();
  private readonly fence = deferred<void>();
  private fenceEntered = false;
  private checkpointPending = false;
  private releasePending = false;
  private checkpointRequested = false;
  private releaseRequested = false;
  private releasing = false;
  private outgoing = resolved();
  readonly document: FrameworkTraceDocument;
  constructor(
    readonly role: Role,
    private readonly valid: () => boolean,
  ) {
    this.document =
      role === "tester"
        ? { kind: role, bind: (input) => this.bind(input) }
        : { kind: role, waitForTesterTrace: () => this.waitForTesterTrace() };
  }
  get ready(): boolean {
    return this.role === "orchestrator" || this.binding !== undefined;
  }
  private bind(input: Binding): void {
    if (this.binding || this.generation) {
      this.fail();
      throw new Error("Trace binding must precede admission exactly once");
    }
    this.binding = input;
  }
  admit(generation: string, iframeId: string, transport: PageTransport): void {
    if (this.generation || !this.valid() || (this.role === "tester" && !this.binding))
      throw new Error("Invalid trace page admission");
    if (!iframeId) throw new Error("Missing actual tester iframe identity");
    this.generation = generation;
    this.iframeId = iframeId;
    this.transport = transport;
    // This pure delivery has a separate lifetime from evidence. No fixture callback runs here.
    if (this.role === "orchestrator")
      void transport.authorization.then(
        (value) => {
          if (value !== "dispose" && value !== "abandon") this.failed = true;
          this.fence.resolve();
        },
        () => {
          this.failed = true;
          this.fence.resolve();
        },
      );
  }
  private post(body: object): Promise<void> {
    // Fixed slots bound this chain: terminal, failure, and one operation per kind.
    withoutPrototype(body, null);
    const next = this.outgoing.then(() => this.transport!.post(body));
    this.outgoing = next.catch(() => {});
    return next;
  }
  private track(work: () => Promise<void>): void {
    let ticket: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    try {
      ticket = deferred<void>();
      this.addPending(ticket.promise);
      void this.consume(work, ticket);
    } catch {
      this.fail();
      if (!ticket) return;
      this.deletePending(ticket.promise);
      ticket.resolve();
    }
  }
  private async consume(
    work: () => Promise<void>,
    ticket: ReturnType<typeof Promise.withResolvers<void>>,
  ): Promise<void> {
    try {
      await this.pulse;
      await work();
    } catch {
      this.fail();
    } finally {
      this.deletePending(ticket.promise);
      ticket.resolve();
    }
  }
  private fail(reason: "conversion" | "source-lost" | "reentry" = "conversion"): void {
    if (this.failed) return;
    this.failed = true;
    try {
      if (this.transport && !this.quiet) this.track(() => this.post({ kind: "failure", reason }));
    } catch {
      // Failure is already sticky even when its diagnostic cannot be allocated.
    }
  }
  incoming(value: unknown): void {
    try {
      const data = message(value);
      if (
        !data ||
        !this.generation ||
        data.iframeId !== this.iframeId ||
        this.quiet ||
        this.failed ||
        !this.valid()
      )
        return;
      if (this.role === "tester" && data.event === "cleanup") {
        if (this.match) {
          this.fail();
          return;
        }
        this.match = data;
      }
      if (this.role === "orchestrator" && data.event === "response:cleanup" && this.matches(data))
        this.responseMatched = true;
    } catch {
      this.fail();
    }
  }
  private matches(data: Match): boolean {
    return data.iframeId === this.match?.iframeId && data.messageId === this.match.messageId;
  }
  /** Called only after the captured original post returned, never instead of it. */
  posted(value: unknown): void {
    if (this.observing) {
      this.fail("reentry");
      return;
    }
    this.observing = true;
    try {
      this.observe(value);
    } catch {
      this.fail();
    } finally {
      this.observing = false;
    }
  }
  private observe(value: unknown): void {
    if (!this.generation || this.quiet || this.failed || !this.valid()) return;
    const data = message(value);
    if (!data || data.iframeId !== this.iframeId) return;
    if (this.role === "orchestrator" && data.event === "cleanup") {
      this.match = data;
      return;
    }
    if (this.role !== "tester" || data.event !== "response:cleanup" || !this.matches(data)) return;
    if (this.text !== undefined) return;
    const text = this.snapshot();
    if (this.failed) return;
    this.text = text;
    this.track(() => this.post({ kind: "terminal", text }));
  }
  private snapshot(): string {
    if (this.snapshotting || !this.binding) {
      this.fail("reentry");
      throw new Error("Trace snapshot reentry or missing binding");
    }
    this.snapshotting = true;
    try {
      const text = this.binding.snapshot();
      if (typeof text !== "string" || text.length > resultByteLimit)
        throw new Error("Trace snapshot exceeds 48 KiB");
      if (apply(encode, new Encoder(), [text]).byteLength > resultByteLimit)
        throw new Error("Trace snapshot exceeds 48 KiB");
      if (this.failed) throw new Error("Trace snapshot failed during conversion");
      return text;
    } finally {
      this.snapshotting = false;
    }
  }
  command(value: unknown): void {
    if (own(value, "kind") === "abandon") {
      this.failed = true;
      this.track(() => this.transport!.closeEvidence());
      return;
    }
    try {
      this.receiveCommand(value);
    } catch {
      this.fail();
    }
  }
  private receiveCommand(value: unknown): void {
    if (!this.transport || this.quiet || this.failed || !this.valid())
      throw new Error("Trace command outside admitted document");
    const kind = own(value, "kind");
    if (kind === "settle") {
      const artifact = own(value, "artifact");
      if (own(value, "generation") !== this.generation || typeof artifact !== "string")
        throw new Error("Invalid trace acknowledgement");
      this.quiet = true;
      void this.settle(artifact).catch(() => this.fail());
      return;
    }
    if (this.role !== "tester") throw new Error("Wrong trace command role");
    if (kind === "checkpoint") {
      this.checkpoint();
      return;
    }
    if (kind === "release") {
      this.release();
      return;
    }
    throw new Error("Unknown trace command");
  }
  private checkpoint(): void {
    if (this.snapshotting) {
      this.fail("reentry");
      throw new Error("Checkpoint snapshot reentry");
    }
    if (this.checkpointPending) {
      if (this.checkpointRequested) throw new Error("Checkpoint reentry");
      this.checkpointRequested = true;
      return;
    }
    this.checkpointPending = true;
    const text = this.text ?? this.snapshot();
    this.track(async () => {
      try {
        await this.post({ kind: "checkpoint", text });
      } finally {
        this.checkpointPending = false;
        if (this.checkpointRequested && !this.failed && !this.quiet) {
          this.checkpointRequested = false;
          this.checkpoint();
        }
      }
    });
  }
  private release(): void {
    if (this.releasing) {
      this.fail("reentry");
      throw new Error("Original RPC release reentry");
    }
    if (!this.binding) throw new Error("Missing RPC release binding");
    if (this.releasePending) {
      if (this.releaseRequested) throw new Error("RPC release reentry");
      this.releaseRequested = true;
      return;
    }
    this.releasePending = true;
    this.releasing = true;
    try {
      this.binding.releaseOriginalRpc();
    } finally {
      this.releasing = false;
    }
    this.track(async () => {
      try {
        await this.post({ kind: "release" });
      } finally {
        this.releasePending = false;
        if (this.releaseRequested && !this.failed && !this.quiet) {
          this.releaseRequested = false;
          this.release();
        }
      }
    });
  }
  private async settle(artifact: string): Promise<void> {
    await this.transport!.closeEvidence();
    while (this.pending.size) {
      for (const work of this.pendingValues()) await work;
    }
    if (this.failed) return;
    this.binding = undefined;
    this.transport!.receipt(withoutPrototype({ artifact, generation: this.generation }, null));
    // A queued receipt never resolves the destruction fence. Only authorization does.
  }
  private waitForTesterTrace(): Promise<void> {
    if (this.fenceEntered) return this.fence.promise;
    this.fenceEntered = true;
    if (!this.generation || !this.responseMatched || !this.valid()) {
      this.fail();
      return this.fence.promise;
    }
    this.track(() => this.post({ kind: "fence" }));
    return this.fence.promise;
  }
  lost(): void {
    try {
      this.fail("source-lost");
      if (this.transport) this.track(() => this.transport!.closeEvidence());
    } catch {
      this.failed = true;
    }
  }
}

/** Preserve receiver, argument list, exact return object, and all original thrown values. */
export function tracePostObserver<T extends (...args: never[]) => unknown>(
  original: T,
  owner: FrameworkTracePageOwner,
  channel: () => unknown,
): T {
  return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
    const result = apply(original, this, args);
    try {
      if (this === channel()) owner.posted(args[0]);
    } catch {
      try {
        owner.lost();
      } catch {
        // Observation failure cannot replace the successful original return.
      }
    }
    return result;
  } as T;
}

type Configuration = { run: string; token: string; kind: Role; url: string };
export function installFrameworkTracePage(
  config: Configuration,
  doc: string,
  valid: () => boolean,
) {
  const owner = new FrameworkTracePageOwner(config.kind, valid);
  const NativeChannel = BroadcastChannel;
  const nativePost = NativeChannel.prototype.postMessage;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const fetchCaptured = fetch.bind(globalThis);
  const beacon = navigator.sendBeacon.bind(navigator);
  const NativeEvents = EventSource;
  const closeEvents = NativeEvents.prototype.close;
  const responseText = Response.prototype.text;
  const responseOK = descriptor(Response.prototype, "ok")?.get;
  if (!responseOK) throw new Error("Missing native response status reader");
  const construct = Reflect.construct;
  const eventData = descriptor(MessageEvent.prototype, "data")?.get;
  if (!eventData) throw new Error("Missing native message data reader");
  let channel: BroadcastChannel | undefined;
  let session: string | undefined;
  const incoming = (event: Event) => {
    try {
      owner.incoming(apply(eventData, event, []));
    } catch {
      owner.lost();
    }
  };
  const wrapper = tracePostObserver(nativePost, owner, () => channel);
  NativeChannel.prototype.postMessage = wrapper;
  const constructor = new Proxy(NativeChannel, {
    construct(target, args, newTarget) {
      const result = construct(target, args, newTarget);
      try {
        captureChannel(result, args);
      } catch {
        owner.lost();
      }
      return result;
    },
  });
  function captureChannel(result: BroadcastChannel, args: unknown[]): void {
    const state = own(globalThis, "__vitest_browser_runner__");
    const id = own(state, "sessionId"),
      role = own(state, "type");
    if (typeof id === "string" && role === config.kind && args[0] === `vitest:${id}` && !channel) {
      channel = result;
      session = id;
      apply(add, result, ["message", incoming]);
    }
  }
  globalThis.BroadcastChannel = constructor;
  Object.defineProperty(globalThis, Symbol.for("waffle.framework.trace"), {
    value: () => (valid() ? owner.document : undefined),
  });
  return {
    ready: () => channel !== undefined && session !== undefined && owner.ready,
    session: () => (channel !== undefined && owner.ready ? (session ?? null) : null),
    admit(generation: string, iframeId: string): void {
      if (!channel || !session)
        throw new Error("Actual Vitest channel not captured before admission");
      const base = `/__waffle_framework_trace/${config.kind}/`;
      const query = `?doc=${encodeURIComponent(doc)}&token=${encodeURIComponent(config.token)}&generation=${encodeURIComponent(generation)}`;
      const stream = new NativeEvents(base + "stream" + query);
      const authorization =
        config.kind === "orchestrator"
          ? fetchCaptured(base + "authorize" + query).then(async (response) => {
              if (!apply(responseOK, response, [])) throw new Error("Trace authorization refused");
              const text = await apply(responseText, response, []);
              if (text !== "dispose" && text !== "abandon")
                throw new Error("Invalid disposal authorization");
              return text;
            })
          : resolved("");
      const transport: PageTransport = {
        post: async (body) => {
          const response = await fetchCaptured(base + "body" + query, {
            method: "POST",
            body: stringify(body),
          });
          if (
            !apply(responseOK, response, []) ||
            (await apply(responseText, response, [])) !== "ok"
          )
            throw new Error("Trace body refused");
        },
        receipt: (body) => {
          beacon(base + "receipt" + query, stringify(body));
        },
        closeEvidence: async () => {
          apply(closeEvents, stream, []);
          apply(remove, stream, ["message", command]);
          apply(remove, stream, ["error", failed]);
          if (channel) apply(remove, channel, ["message", incoming]);
          if (NativeChannel.prototype.postMessage === wrapper)
            NativeChannel.prototype.postMessage = nativePost;
          if (globalThis.BroadcastChannel === constructor)
            globalThis.BroadcastChannel = NativeChannel;
        },
        authorization,
      };
      const command = (event: Event) => {
        try {
          owner.command(parse(apply(eventData, event, [])));
        } catch {
          owner.lost();
        }
      };
      const failed = () => owner.lost();
      apply(add, stream, ["message", command]);
      apply(add, stream, ["error", failed]);
      owner.admit(generation, iframeId, transport);
    },
    lost: () => owner.lost(),
  };
}
