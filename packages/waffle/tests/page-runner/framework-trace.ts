import type { IncomingMessage, ServerResponse } from "node:http";
import { incomingBody } from "./framework-http-body.js";
import { randomUUID } from "node:crypto";
import { bounded, type CleanupStep } from "./driver.js";
import type { FrameworkDocument } from "./framework-collector.js";
import { readReportBody } from "./collector-fetch.js";
import { record, resultByteLimit } from "./protocol.js";
import type {
  CollectorDelivery,
  CollectorObservation,
  TesterTraceCapture,
  TesterTraceOptions,
  TraceCheckpoint,
  TraceFailure,
  TraceSettlement,
} from "./framework-types.js";

const now = performance.now.bind(performance);
export const tracePath = "/__waffle_framework_trace/";
type Role = "orchestrator" | "tester";
type Pair = { readonly orchestrator: FrameworkDocument; readonly tester: FrameworkDocument };
type Operation<T> = ReturnType<typeof Promise.withResolvers<T>>;
type Stream = { readonly response: ServerResponse };
type Artifact = { readonly text: string; readonly utf8Bytes: number; readonly id: string };
// Only the receiver constructs this value, after both receipt handlers physically join.
const evidenceReceipt: unique symbol = Symbol("joined trace evidence");
type EvidenceReceipt = {
  readonly [evidenceReceipt]: true;
  readonly pair: Pair;
  readonly artifact: Artifact;
};

/** Private host owner. Admission is called only after the existing physical DOM challenge. */
export class FrameworkTraceOwner {
  private pair: Pair | undefined;
  private readonly generation = randomUUID();
  private failure: TraceFailure | undefined;
  private sealed: TraceSettlement | undefined;
  private live = true;
  private readonly cancellation = new AbortController();
  private readonly sockets = new Set<ServerResponse>();
  private readonly liveConsumers = new Set<Promise<void>>();
  private readonly collectorConsumers = new Set<Promise<void>>();
  private closed = false;
  private readonly evidence = new Set<Promise<void>>();
  private readonly slots = new Set<string>();
  private readonly streams = new Map<Role, Stream>();
  private authorization: Stream | undefined;
  private authorizationUsed = false;
  private evidenceClosed = false;
  private readonly authorizationConsumers = new Set<Promise<void>>();
  private artifact: Artifact | undefined;
  private prefix: string | undefined;
  private fence = false;
  private settling = false;
  private readonly done = Promise.withResolvers<void>();
  private readonly testerReceipt = Promise.withResolvers<void>();
  private readonly topReceipt = Promise.withResolvers<void>();
  private checkpointOperation: Operation<TraceCheckpoint> | undefined;
  private releaseOperation: Operation<void> | undefined;
  private decisions = 0;
  private readonly ready = Promise.withResolvers<void>();
  private checkpointJoin: Operation<void> | undefined;
  private releaseJoin: Operation<void> | undefined;
  private completing: "checkpoint" | "release" | undefined;
  private destructionAllowed = false;
  readonly capture: TesterTraceCapture = {
    checkpoint: () => this.checkpoint(),
    releaseOriginalRpc: () => this.releaseOriginalRpc(),
  };
  constructor(
    private readonly options: TesterTraceOptions,
    private readonly onFailure: (reason: TraceFailure) => void = () => {},
  ) {}
  get pending(): boolean {
    return !this.destructionAllowed && !!this.pair;
  }
  admit(orchestrator: FrameworkDocument, tester: FrameworkDocument): string {
    if (this.pair || !orchestrator.admitted || !tester.admitted || !orchestrator.doc || !tester.doc)
      throw new Error("Trace requires the actual admitted pair exactly once");
    this.pair = { orchestrator, tester };
    return this.generation;
  }
  cancelLiveOperations(): void {
    this.live = false;
    this.cancellation.abort(new Error("Trace fixture admission closed"));
    this.checkpointOperation?.reject(new Error("Trace checkpoint cancelled"));
    this.releaseOperation?.reject(new Error("Trace RPC release cancelled"));
    // The page's original RPC result is never released by cancelling ACK gates.
  }
  private reject(reason: TraceFailure): void {
    if (this.failure || this.sealed) return;
    this.failure = reason;
    this.onFailure(reason);
  }
  abandon(reason: TraceFailure): void {
    this.reject(reason);
    this.cancelLiveOperations();
    this.destructionAllowed = true;
    this.writeAuthorization("abandon");
    for (const stream of this.streams.values())
      this.end(stream.response, 'data: {"kind":"abandon"}\n\n');
    this.ready.resolve();
    this.testerReceipt.resolve();
    this.topReceipt.resolve();
    this.done.resolve();
  }
  private liveTester(): Stream {
    const stream = this.streams.get("tester");
    if (!this.pair || !this.live || this.failure || this.sealed || !stream)
      throw new Error("Trace fixture operations are not live and admitted");
    return stream;
  }
  private checkpoint(): Promise<TraceCheckpoint> {
    const stream = this.liveTester();
    if (this.checkpointOperation) return Promise.reject(new Error("Checkpoint slot occupied"));
    const operation = Promise.withResolvers<TraceCheckpoint>();
    this.checkpointOperation = operation;
    this.checkpointJoin = Promise.withResolvers<void>();
    this.liveConsumers.add(this.checkpointJoin.promise);
    this.send(stream, { kind: "checkpoint" });
    return operation.promise;
  }
  private releaseOriginalRpc(): Promise<void> {
    const stream = this.liveTester();
    if (this.releaseOperation) return Promise.reject(new Error("RPC release slot occupied"));
    const operation = Promise.withResolvers<void>();
    this.releaseOperation = operation;
    this.releaseJoin = Promise.withResolvers<void>();
    this.liveConsumers.add(this.releaseJoin.promise);
    this.send(stream, { kind: "release" });
    return operation.promise;
  }
  /** Reserve before parsing or entering a fixture callback. The socket and handler share one owner. */
  reserveResponse(
    outgoing: ServerResponse,
  ): ((work: (fixtureDecision: boolean) => Promise<void>) => void) | undefined {
    if (this.closed) return;
    if (this.decisions >= 64) {
      this.abandon("capacity");
      return;
    }
    // Bootstrap and later ordinary retirement stay bounded without admitting fixture callbacks.
    const evidenceLive = this.live && !this.failure && !this.sealed;
    const fixtureDecision = !!this.pair && evidenceLive;
    const group = evidenceLive ? this.liveConsumers : this.collectorConsumers;
    this.decisions++;
    return (work) => {
      void this.own(outgoing, group, () => work(fixtureDecision)).finally(() => this.decisions--);
    };
  }
  async collectorResponse(observation: CollectorObservation): Promise<CollectorDelivery> {
    const delivery = await this.options.collectorResponse(observation, this.cancellation.signal);
    if (delivery !== "unchanged" && delivery !== "malformed-ack") {
      this.abandon("conversion");
      throw new Error("Invalid fixture collector decision");
    }
    return delivery;
  }
  private async own(
    outgoing: ServerResponse,
    group: Set<Promise<void>>,
    work: () => Promise<void>,
  ): Promise<void> {
    const ticket = Promise.withResolvers<void>();
    const socket = Promise.withResolvers<void>();
    group.add(ticket.promise);
    this.sockets.add(outgoing);
    const finish = () => socket.resolve();
    const close = () => {
      if (!outgoing.writableFinished) this.abandon("consumers-unconfirmed");
      socket.resolve();
    };
    outgoing.once("error", close);
    outgoing.once("finish", finish);
    outgoing.once("close", close);
    try {
      await work();
    } catch {
      this.abandon("receipt");
      if (!outgoing.headersSent) outgoing.writeHead(409);
      if (!outgoing.destroyed) outgoing.end();
    } finally {
      await socket.promise;
      outgoing.off("error", close);
      outgoing.off("finish", finish);
      outgoing.off("close", close);
      this.sockets.delete(outgoing);
      group.delete(ticket.promise);
      ticket.resolve();
    }
  }
  handle(incoming: IncomingMessage, outgoing: ServerResponse): boolean {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(tracePath)) return false;
    const parts = url.pathname.slice(tracePath.length).split("/");
    const role = parts[0],
      slot = parts[1];
    if (
      (role !== "tester" && role !== "orchestrator") ||
      !["body", "receipt", "stream", "authorize"].includes(slot ?? "")
    ) {
      outgoing.writeHead(404).end();
      return true;
    }
    // Route role slots, not untrusted body identity, bound ingress before any body reader exists.
    const key = `${role}/${slot}`;
    if (
      !this.pair ||
      this.failure ||
      this.sealed ||
      this.evidenceClosed ||
      this.slots.has(key) ||
      (slot === "authorize" && (role !== "orchestrator" || this.authorizationUsed))
    ) {
      outgoing.writeHead(409).end();
      return true;
    }
    this.slots.add(key);
    const authorization = slot === "authorize";
    const group = authorization
      ? this.authorizationConsumers
      : slot === "body"
        ? this.liveConsumers
        : this.evidence;
    const joined = this.own(outgoing, group, () =>
      this.receive(incoming, outgoing, url, role, slot),
    );
    void joined.then(() => {
      this.slots.delete(key);
      if (slot === "body" && role === "tester") this.commandJoined();
      if (slot === "receipt") this.receiptJoined(role);
    });
    return true;
  }
  private identity(url: URL, role: Role): boolean {
    const source = this.pair?.[role];
    return (
      !!source &&
      source.doc !== null &&
      url.searchParams.get("doc") === source.doc &&
      url.searchParams.get("token") === source.token &&
      url.searchParams.get("generation") === this.generation
    );
  }
  private async receive(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    url: URL,
    role: Role,
    slot: string | undefined,
  ): Promise<void> {
    if (!this.identity(url, role)) {
      outgoing.writeHead(409).end();
      return;
    }
    if (slot === "stream" || slot === "authorize") {
      if (incoming.method !== "GET") {
        outgoing.writeHead(405).end();
        return;
      }
      this.openStream(outgoing, role, slot === "authorize");
      return;
    }
    if (incoming.method !== "POST") {
      outgoing.writeHead(405).end();
      return;
    }
    const controller = new AbortController();
    const aborted = () => controller.abort();
    incoming.once("aborted", aborted);
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        body: incomingBody(incoming),
        signal: controller.signal,
        duplex: "half",
      };
      const request = new Request(url, init);
      const body = await readReportBody(request);
      if (slot === "receipt") this.receipt(body, role);
      else this.body(body, role);
      outgoing.writeHead(200, { "Cache-Control": "no-store" }).end("ok");
    } finally {
      incoming.off("aborted", aborted);
    }
  }
  private openStream(response: ServerResponse, role: Role, authorization: boolean): void {
    response.writeHead(200, {
      "Content-Type": authorization ? "text/plain" : "text/event-stream",
      "Cache-Control": "no-store",
    });
    response.flushHeaders();
    const stream = { response };
    if (authorization) {
      this.authorizationUsed = true;
      this.authorization = stream;
    } else if (!this.streams.has(role)) this.streams.set(role, stream);
    else {
      response.end();
      this.abandon("receipt");
    }
    if (this.authorization && this.streams.size === 2) this.ready.resolve();
  }
  private body(body: unknown, role: Role): void {
    if (!record(body) || this.failure) throw new Error("Invalid or failed trace body");
    if (body.kind === "failure") {
      if (
        body.reason !== "conversion" &&
        body.reason !== "source-lost" &&
        body.reason !== "reentry"
      )
        throw new Error("Invalid page trace failure");
      this.abandon(body.reason);
      return;
    }
    if (body.kind === "fence" && role === "orchestrator") {
      if (this.fence) throw new Error("Repeated trace fence");
      this.fence = true;
      this.maybeSettle();
      return;
    }
    if (role !== "tester") throw new Error("Wrong trace role");
    if (body.kind === "release" && this.releaseOperation) {
      this.releaseOperation.resolve();
      this.completing = "release";
      return;
    }
    if (body.kind !== "terminal" && body.kind !== "checkpoint")
      throw new Error("Unknown trace body");
    if (typeof body.text !== "string" || body.text.length > resultByteLimit)
      throw new Error("Trace text exceeds 48 KiB");
    const utf8Bytes = new TextEncoder().encode(body.text).byteLength;
    if (utf8Bytes > resultByteLimit) throw new Error("Trace text exceeds 48 KiB");
    if (body.kind === "checkpoint") {
      if (!this.checkpointOperation) throw new Error("Unowned checkpoint");
      this.prefix = body.text;
      this.checkpointOperation.resolve({ kind: "checkpoint", text: body.text });
      this.completing = "checkpoint";
      return;
    }
    if (this.artifact && this.artifact.text !== body.text) {
      this.abandon("receipt");
      return;
    }
    this.artifact ??= { text: body.text, utf8Bytes, id: randomUUID() };
    this.maybeSettle();
  }
  private commandJoined(): void {
    const joined =
      this.completing === "checkpoint"
        ? this.checkpointJoin
        : this.completing === "release"
          ? this.releaseJoin
          : undefined;
    if (joined) {
      this.liveConsumers.delete(joined.promise);
      joined.resolve();
    }
    if (this.completing === "checkpoint") {
      this.checkpointJoin = undefined;
      this.checkpointOperation = undefined;
    }
    if (this.completing === "release") {
      this.releaseJoin = undefined;
      this.releaseOperation = undefined;
    }
    this.completing = undefined;
  }
  private readonly acknowledged = new Set<Role>();
  private readonly received = new Set<Role>();
  private receipt(body: unknown, role: Role): void {
    if (
      !record(body) ||
      body.artifact !== this.artifact?.id ||
      body.generation !== this.generation ||
      !this.settling ||
      !this.acknowledged.has(role) ||
      this.failure
    )
      throw new Error("Invalid terminal receipt");
    if (role === "orchestrator" && !this.received.has("tester"))
      throw new Error("Top receipt before tester");
    this.received.add(role);
  }
  private receiptJoined(role: Role): void {
    if (!this.received.has(role) || this.failure) return;
    if (role === "tester") this.testerReceipt.resolve();
    else this.topReceipt.resolve();
  }
  private send(stream: Stream, body: object): void {
    stream.response.write(`data: ${JSON.stringify(body)}\n\n`);
  }
  private maybeSettle(): void {
    if (!this.artifact || !this.fence || this.settling || this.failure) return;
    this.settling = true;
    this.live = false;
    void this.settleEvidence().catch(() => this.abandon("consumers-unconfirmed"));
  }
  private async join(group: Set<Promise<void>>): Promise<void> {
    while (group.size) await Promise.all(group);
  }
  private ack(role: Role, artifact: Artifact): void {
    const stream = this.streams.get(role);
    if (!stream) throw new Error("Missing admitted trace stream");
    this.send(stream, { kind: "settle", generation: this.generation, artifact: artifact.id });
    this.acknowledged.add(role);
    stream.response.end();
  }
  private async settleEvidence(): Promise<void> {
    await this.ready.promise;
    await this.join(this.liveConsumers);
    const artifact = this.artifact,
      pair = this.pair;
    if (!artifact || !pair || this.failure) return;
    this.ack("tester", artifact);
    await this.testerReceipt.promise;
    if (this.failure) return;
    this.ack("orchestrator", artifact);
    await this.topReceipt.promise;
    await this.join(this.evidence);
    await this.join(this.liveConsumers);
    if (this.failure) return;
    this.evidenceClosed = true;
    const receipt: EvidenceReceipt = { [evidenceReceipt]: true, pair, artifact };
    await this.authorize(receipt);
  }
  private end(response: ServerResponse, text: string): void {
    if (!response.destroyed && !response.writableEnded) response.end(text);
  }
  private writeAuthorization(text: "dispose" | "abandon"): void {
    if (this.authorization) this.end(this.authorization.response, text);
  }
  private async authorize(receipt: EvidenceReceipt): Promise<void> {
    if (!this.authorization) throw new Error("Missing pre-admitted authorization delivery");
    this.writeAuthorization("dispose");
    await this.join(this.authorizationConsumers);
    if (this.failure) return;
    const doc = receipt.pair.tester.doc;
    if (!doc) throw new Error("Lost admitted source");
    this.sealed = {
      status: "confirmed",
      source: { kind: "tester", doc, url: receipt.pair.tester.url },
      artifact: { text: receipt.artifact.text, utf8Bytes: receipt.artifact.utf8Bytes },
    };
    this.destructionAllowed = true;
    this.done.resolve();
  }
  async settleBeforeDestruction(deadlineAt: number): Promise<TraceSettlement> {
    if (!this.pair) this.abandon("not-admitted");
    if (!this.sealed && !this.failure && deadlineAt <= now()) this.abandon("deadline");
    if (!this.sealed && !this.failure) {
      try {
        await bounded(
          this.done.promise,
          Math.max(1, deadlineAt - now()),
          "Final tester trace settlement",
        );
      } catch {
        this.abandon("deadline");
      }
    }
    return this.result();
  }
  result(): TraceSettlement {
    if (this.sealed) return this.sealed;
    const retained = this.artifact
      ? { kind: "terminal-unconfirmed" as const, text: this.artifact.text }
      : this.prefix === undefined
        ? null
        : { kind: "prefix" as const, text: this.prefix };
    return (this.sealed = {
      status: "incomplete",
      reason: this.failure ?? "missing-cleanup-response",
      retained,
    });
  }
  async close(deadlineAt: number, sourceDestroyed = false): Promise<CleanupStep> {
    this.closed = true;
    this.cancelLiveOperations();
    for (const socket of this.sockets) socket.destroy();
    // Destruction cancels delivery, not a still-running callback/body conversion.
    // Missing command replies have no server callback left after their source is gone.
    for (const operation of [this.checkpointJoin, this.releaseJoin]) {
      if (operation && sourceDestroyed) {
        this.liveConsumers.delete(operation.promise);
        operation.resolve();
      }
    }
    try {
      await bounded(
        Promise.all([
          this.join(this.liveConsumers),
          this.join(this.collectorConsumers),
          this.join(this.evidence),
          this.join(this.authorizationConsumers),
        ]),
        Math.max(1, deadlineAt - now()),
        "Trace consumers physically stopped",
      );
      return { status: "confirmed", detail: "Trace response and body consumers joined" };
    } catch {
      return { status: "unconfirmed", detail: "Trace consumer settlement unconfirmed" };
    }
  }
}
