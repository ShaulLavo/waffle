import { consoleMessage, consoleFailure, consoleExpired } from "./safari-console.js";
import type { WorkerConsoleOrder } from "./console-observation.js";
import { randomUUID } from "node:crypto";
import { bounded, type DriverObservationBinding } from "./driver.js";
import {
  BrowserObservation,
  workerEvent,
  terminatedWorker,
  requestEvent,
} from "./browser-observation.js";
import {
  InspectorStream,
  type InspectorTransport,
  type InspectorEnvelope,
} from "./inspector-stream.js";
import { isDict, type PlistDict } from "./inspector-plist.js";
import { record } from "./protocol.js";

type Message =
  | { kind: "reply"; id: number; answer: Record<string, unknown> }
  | { kind: "event"; method: string; params: Record<string, unknown> };
type ReplyRoute = { kind: "target" } | { kind: "page" } | { kind: "worker"; id: string };
type Pending = ReturnType<typeof Promise.withResolvers<unknown>> & {
  route: ReplyRoute;
  reduced?: () => void;
};
type WorkerConsole = { -readonly [K in keyof WorkerConsoleOrder]: WorkerConsoleOrder[K] };
type Command =
  | "Console.enable"
  | "Console.disable"
  | "Worker.sendMessageToWorker"
  | "Page.enable"
  | "Page.disable"
  | "Worker.enable"
  | "Worker.disable"
  | "Worker.initialized"
  | "Network.enable"
  | "Network.disable"
  | "Runtime.evaluate";
type Selection = { application: string; page: number };
type MetadataWait = {
  match: (event: InspectorEnvelope) => boolean;
  pending: ReturnType<typeof Promise.withResolvers<InspectorEnvelope>>;
};
export const observationIdentityExpression = `JSON.stringify({url:location.href,marker:document.documentElement.getAttribute('data-waffle-observation')})`;

function sameReplyRoute(expected: ReplyRoute, actual: ReplyRoute): boolean {
  if (expected.kind === "worker") return actual.kind === "worker" && expected.id === actual.id;
  return expected.kind === actual.kind;
}

function parseMessage(text: string): Message {
  if (Buffer.byteLength(text) > 1 << 20) throw new Error("Inspector JSON size bound exceeded");
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error("Invalid Inspector message");
  if (typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0) {
    if (!("result" in value) && !("error" in value))
      throw new Error("Inspector reply has no outcome");
    return { kind: "reply", id: value.id, answer: value };
  }
  if (typeof value.method !== "string" || !value.method || "id" in value)
    throw new Error("Invalid Inspector event");
  const params = value.params ?? {};
  if (!record(params)) throw new Error("Invalid Inspector event parameters");
  return { kind: "event", method: value.method, params };
}
function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Buffer.isBuffer(value)) throw new Error("Invalid Inspector message bytes");
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

/** Observe one page selected and confirmed by its existing SafariDriver. No page actions. */
export class SafariObserver {
  private transport: InspectorTransport | undefined;
  private readonly connection = randomUUID().toUpperCase();
  private readonly sender = randomUUID().toUpperCase();
  private selection: Selection | undefined;
  private target: string | undefined;
  private nextID = 1;
  private failed: Error | undefined;
  private dispatchOpen = true;
  private detaching = false;
  private targetRetired = false;
  private detachConfirmed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly initializations = new Set<Promise<unknown>>();
  private readonly metadata = new Set<MetadataWait>();
  private readonly applications = new Set<string>();
  private readonly listings = new Map<string, PlistDict>();
  private attached = false;
  private document: { frame: string; loader: string } | undefined;
  private navigationConfirmed = false;
  private enabledPage = false;
  private enabledWorker = false;
  private enabledNetwork = false;
  private enabledConsole = false;
  private order = 0;
  private readonly workerConsole = new Map<string, WorkerConsole>();
  private ledger: BrowserObservation | undefined;
  private consoleCutoff: Promise<void> | undefined;
  private closeWork: Promise<void> | undefined;
  private abort: (() => void) | undefined;
  constructor(private readonly binding: DriverObservationBinding) {}
  static async open(path: string, binding: DriverObservationBinding): Promise<BrowserObservation> {
    const session = new SafariObserver(binding);
    try {
      session.transport = await binding.consumers.invoke(() =>
        InspectorStream.connect(
          path,
          binding.consumers,
          (event) => session.accept(event),
          (error) => session.lose(error),
        ),
      );
      return await session.attach();
    } catch (error) {
      session.lose(error);
      await session.close().catch(() => {});
      throw error;
    }
  }
  /** CPU controls use the same envelope parser and command reducer, not Safari support. */
  connectTransport(transport: InspectorTransport): void {
    if (this.transport) throw new Error("Inspector transport already owned");
    this.transport = transport;
  }
  accept(event: InspectorEnvelope): void {
    try {
      this.reduce(event);
    } catch (error) {
      this.lose(error);
    }
  }
  lose(error: unknown): void {
    this.failed ??= error instanceof Error ? error : new Error(String(error));
    this.dispatchOpen = false;
    this.ledger?.lose(this.failed);
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.pending.clear();
    for (const waiter of this.metadata) waiter.pending.reject(this.failed);
  }
  private check(cleanup = false): void {
    if (this.failed) throw this.failed;
    if (!cleanup && !this.dispatchOpen) throw new Error("Inspector dispatch revoked");
    if (!cleanup) this.binding.signal.throwIfAborted();
  }
  private send(selector: string, argument: PlistDict, cleanup = false): Promise<void> {
    return this.binding.consumers.invoke(() => {
      this.check(cleanup);
      if (!this.transport) throw new Error("Inspector transport not connected");
      return this.transport.send(selector, argument);
    });
  }
  private waitMetadata(match: MetadataWait["match"]): Promise<InspectorEnvelope> {
    this.check();
    const waiter: MetadataWait = { match, pending: Promise.withResolvers<InspectorEnvelope>() };
    this.metadata.add(waiter);
    return bounded(waiter.pending.promise, 3000, "Inspector metadata").finally(() =>
      this.metadata.delete(waiter),
    );
  }
  private async metadataCommand(
    selector: string,
    argument: PlistDict,
    match: MetadataWait["match"],
  ): Promise<void> {
    const answer = this.waitMetadata(match);
    await Promise.all([answer, this.send(selector, argument)]);
  }
  private arguments(): PlistDict {
    if (!this.selection) throw new Error("No exact Inspector page selection");
    return {
      WIRApplicationIdentifierKey: this.selection.application,
      WIRPageIdentifierKey: this.selection.page,
      WIRConnectionIdentifierKey: this.connection,
      WIRSenderKey: this.sender,
    };
  }
  async attach(): Promise<BrowserObservation> {
    await this.metadataCommand(
      "_rpc_reportIdentifier:",
      { WIRConnectionIdentifierKey: this.connection },
      (event) => event.selector === "_rpc_reportConnectedApplicationList:",
    );
    if (!this.applications.size || this.applications.size > 32)
      throw new Error("Inspector application listing bound/refusal");
    await Promise.all(
      Array.from(this.applications, (application) =>
        this.metadataCommand(
          "_rpc_forwardGetListing:",
          { WIRConnectionIdentifierKey: this.connection, WIRApplicationIdentifierKey: application },
          (event) =>
            event.selector === "_rpc_applicationSentListing:" &&
            event.argument.WIRApplicationIdentifierKey === application,
        ),
      ),
    );
    this.selection = this.select();
    const target = this.waitMetadata((event) => {
      if (event.selector !== "_rpc_applicationSentData:") return false;
      return this.target !== undefined;
    });
    this.attached = true;
    await Promise.all([
      target,
      this.send("_rpc_forwardSocketSetup:", {
        ...this.arguments(),
        WIRMessageDataTypeChunkSupportedKey: 0,
      }),
    ]);
    if (!this.target) throw new Error("Exact Inspector target not acknowledged");
    const ledger = new BrowserObservation(
      this.target,
      this.binding.consumers,
      () => this.close(),
      undefined,
      () => this.navigationComplete(),
      () => this.settleConsole(),
      () =>
        Object.freeze(
          Array.from(this.workerConsole.values(), (entry) => Object.freeze({ ...entry })),
        ),
    );
    this.ledger = ledger;
    this.abort = () => {
      this.dispatchOpen = false;
      ledger.lose(new Error("Observation admission aborted"));
    };
    this.binding.signal.addEventListener("abort", this.abort, { once: true });
    this.check();
    const identity = await this.command("Runtime.evaluate", {
      expression: observationIdentityExpression,
      returnByValue: true,
    });
    if (!record(identity) || !record(identity.result) || typeof identity.result.value !== "string")
      throw new Error("Inspector bootstrap identity unavailable");
    const wanted = JSON.stringify({
      url: this.binding.bootstrapURL,
      marker: new URL(this.binding.bootstrapURL).searchParams.get("token"),
    });
    if (identity.result.value !== wanted)
      throw new Error("Inspector exact owned bootstrap identity mismatch");
    if (this.binding.console) {
      await this.command("Console.enable", {});
      this.enabledConsole = true;
    }
    // Page supplies Network frame/loader identities; acknowledge it before admitting requests.
    await this.command("Page.enable", {});
    this.enabledPage = true;
    // Events during enable are reduced before its acknowledgement. Every created worker is resumed immediately.
    await this.command("Worker.enable", {});
    this.enabledWorker = true;
    await this.command("Network.enable", {});
    this.enabledNetwork = true;
    await Promise.all(Array.from(this.initializations));
    this.check();
    return ledger;
  }
  private select(): Selection {
    const matches: Selection[] = [];
    let pages = 0;
    for (const [application, listing] of this.listings) {
      for (const row of Object.values(listing)) {
        if (++pages > 512) throw new Error("Inspector page bound exceeded");
        this.selectRow(application, row, matches);
      }
    }
    const selected = matches[0];
    if (matches.length !== 1 || !selected)
      throw new Error(
        `Exact owned bootstrap not uniquely listed: ${this.listingCounts(matches.length, pages)}`,
      );
    return selected;
  }
  private listingCounts(matches: number, rows: number): string {
    const applications = Array.from(this.listings.values(), (listing, index) => {
      const values = Object.values(listing);
      const pageRows = values.filter(
        (row) =>
          isDict(row) &&
          ["WIRTypeWeb", "WIRTypeWebPage", "WIRTypePage"].includes(String(row.WIRTypeKey)),
      ).length;
      const owned = values.filter(
        (row) => isDict(row) && row.WIRURLKey === this.binding.bootstrapURL,
      ).length;
      return { application: index + 1, rows: values.length, pageRows, matches: owned };
    });
    return JSON.stringify({
      matches,
      applications: this.applications.size,
      listings: this.listings.size,
      rows,
      pageRows: applications.reduce((sum, application) => sum + application.pageRows, 0),
      perApplication: applications,
    });
  }
  private selectRow(application: string, row: unknown, matches: Selection[]): void {
    if (!isDict(row) || row.WIRURLKey !== this.binding.bootstrapURL) return;
    if (!["WIRTypeWeb", "WIRTypeWebPage", "WIRTypePage"].includes(String(row.WIRTypeKey)))
      throw new Error("Owned Inspector match is not a page");
    if (
      typeof row.WIRPageIdentifierKey !== "number" ||
      !Number.isSafeInteger(row.WIRPageIdentifierKey)
    )
      throw new Error("Owned Inspector page has no valid ID");
    if (row.WIRConnectionIdentifierKey)
      throw new Error("Owned Inspector page already has a frontend");
    matches.push({ application, page: row.WIRPageIdentifierKey });
  }
  private reduce(event: InspectorEnvelope): void {
    if (this.failed) return;
    this.reduceMetadata(event);
    if (event.selector === "_rpc_applicationSentData:") this.reduceData(event);
    for (const waiter of this.metadata) {
      if (waiter.match(event)) waiter.pending.resolve(event);
    }
  }
  private reduceMetadata(event: InspectorEnvelope): void {
    const args = event.argument;
    if (event.selector === "_rpc_reportConnectedApplicationList:") {
      if (!isDict(args.WIRApplicationDictionaryKey))
        throw new Error("Invalid Inspector application list");
      for (const key of Object.keys(args.WIRApplicationDictionaryKey)) this.applications.add(key);
    }
    const application = args.WIRApplicationIdentifierKey;
    if (typeof application !== "string") return;
    if (
      event.selector === "_rpc_applicationDisconnected:" &&
      application === this.selection?.application
    )
      throw new Error("Owned Inspector application disconnected");
    if (event.selector !== "_rpc_applicationSentListing:") return;
    if (!isDict(args.WIRListingKey)) throw new Error("Malformed Inspector listing");
    this.listings.set(application, args.WIRListingKey);
    if (this.attached && application === this.selection?.application)
      this.checkListing(args.WIRListingKey);
  }
  private checkListing(listing: PlistDict): void {
    const page = Object.values(listing).find(
      (row) => isDict(row) && row.WIRPageIdentifierKey === this.selection?.page,
    );
    if (!isDict(page)) {
      if (!this.ledger?.closing) throw new Error("Owned Inspector page disappeared");
      this.targetRetired = true;
      this.ledger.documentClosed();
      return;
    }
    if (this.detaching && page.WIRConnectionIdentifierKey !== this.connection) {
      this.detachConfirmed = true;
      return;
    }
    if (page.WIRConnectionIdentifierKey !== this.connection)
      throw new Error("Owned Inspector frontend connection replaced");
  }
  private reduceData(event: InspectorEnvelope): void {
    const args = event.argument;
    if (
      args.WIRApplicationIdentifierKey !== this.selection?.application ||
      args.WIRDestinationKey !== this.sender
    )
      return;
    if (
      args.WIRMessageDataTypeKey !== undefined &&
      args.WIRMessageDataTypeKey !== "WIRMessageDataTypeFull"
    )
      throw new Error("Unexpected chunked Inspector data");
    const message = parseMessage(messageText(args.WIRMessageDataKey));
    if (message.kind === "reply") return this.reply(message, { kind: "target" });
    if (message.method === "Target.targetCreated") return this.createdTarget(message.params);
    if (message.method === "Target.targetDestroyed") {
      if (message.params.targetId !== this.target || !this.ledger?.closing)
        throw new Error("Owned Inspector target destroyed");
      this.targetRetired = true;
      this.ledger.documentClosed();
      return;
    }
    if (message.method !== "Target.dispatchMessageFromTarget") {
      if (message.method.startsWith("Target."))
        throw new Error(`Unsupported Inspector target transition: ${message.method}`);
      return;
    }
    if (message.params.targetId !== this.target || typeof message.params.message !== "string")
      throw new Error("Inspector target lifetime changed");
    const inner = parseMessage(message.params.message);
    if (inner.kind === "reply") return this.reply(inner, { kind: "page" });
    this.event(inner.method, inner.params, event.sequence);
  }
  private createdTarget(params: Record<string, unknown>): void {
    const info = params.targetInfo;
    if (
      !record(info) ||
      typeof info.targetId !== "string" ||
      !info.targetId ||
      info.type !== "page"
    )
      throw new Error("Invalid Inspector page target");
    if (info.isProvisional || info.isPaused)
      throw new Error("Provisional/paused Inspector target is outside observation scope");
    if (this.target && this.target !== info.targetId) throw new Error("Inspector target replaced");
    this.target = info.targetId;
  }
  private reply(message: Extract<Message, { kind: "reply" }>, route: ReplyRoute): void {
    const pending = this.pending.get(message.id);
    if (!pending || !sameReplyRoute(pending.route, route))
      throw new Error("Unowned Inspector reply route");
    if ("error" in message.answer) {
      const error = new Error(`Inspector command refused: ${JSON.stringify(message.answer.error)}`);
      pending.reject(error);
      this.lose(error);
      return;
    }
    pending.reduced?.();
    pending.resolve(message.answer.result);
    this.pending.delete(message.id);
  }
  navigationComplete(): void {
    this.check();
    if (!this.document) {
      const error = new Error(
        "Unqualified Safari observation: navigation request was not received at actual driver completion",
      );
      this.lose(error);
      throw error;
    }
    this.navigationConfirmed = true;
  }
  private request(params: Record<string, unknown>, method: string, sequence: number): void {
    const event = requestEvent(method, params, sequence);
    if (
      this.ledger?.closing &&
      event.url === this.ledger.closingNavigationURL &&
      params.documentURL === event.url
    ) {
      this.ledger.documentClosed();
      return;
    }
    if (params.documentURL !== this.binding.expectedURL)
      throw new Error("Inspector request is outside the exact case document");
    if (!this.document) {
      if (event.url !== this.binding.expectedURL || event.kind !== "request")
        throw new Error("Inspector startup ordering gap before document request");
      this.document = { frame: event.frameId, loader: event.loaderId };
    } else if (this.document.frame !== event.frameId || this.document.loader !== event.loaderId) {
      throw new Error("Inspector document/frame lifetime replaced");
    } else if (event.url === this.binding.expectedURL && this.navigationConfirmed) {
      throw new Error("Unexpected second case document request");
    }
    this.ledger?.requested(event);
  }
  private event(method: string, params: Record<string, unknown>, sequence: number): void {
    const ledger = this.ledger;
    if (!ledger) throw new Error("Inspector target event before observer admission");
    if (method === "Worker.workerCreated") {
      const worker = workerEvent(params);
      if (!ledger.created(worker.id, worker.url)) return;
      const enabling = this.binding.console
        ? this.enableWorkerConsole(worker.id)
        : Promise.resolve();
      const initialization = this.command(
        "Worker.initialized",
        { workerId: worker.id },
        false,
        () => this.workerOrder(worker.id, "initialized"),
        () => this.workerOrder(worker.id, "initializationOuter"),
      );
      const startup = Promise.all([enabling, initialization]);
      this.trackInitialization(startup);
    }
    if (method === "Worker.dispatchMessageFromWorker" && this.binding.console)
      this.workerMessage(params);
    if (method === "Console.messageAdded" && this.binding.console)
      this.consoleEvent("page", params);
    if (method === "Worker.workerTerminated") {
      const id = terminatedWorker(params);
      ledger.terminated(id, "safari-worker-terminated");
      const state = this.workerConsole.get(id);
      if (state) state.terminated = ++this.order;
      if (
        state &&
        (!state.forwarded ||
          !state.forwardingOuter ||
          !state.replied ||
          !state.initialized ||
          !state.initializationOuter)
      )
        throw new Error(`Worker console enable pending at termination: ${JSON.stringify(state)}`);
    }
    if (method === "Network.requestWillBeSent" || method === "Network.requestServedFromMemoryCache")
      this.request(params, method, sequence);
  }
  private workerOrder(id: string, reply: "initialized" | "initializationOuter"): void {
    const state = this.workerConsole.get(id);
    if (state) state[reply] = ++this.order;
  }
  private trackInitialization(initialization: Promise<unknown>): void {
    this.initializations.add(initialization);
    void initialization.then(
      () => this.initializations.delete(initialization),
      (error: unknown) => {
        this.initializations.delete(initialization);
        this.lose(error);
      },
    );
  }
  private consoleEvent(context: string, params: unknown): void {
    const message = consoleMessage(params);
    if (consoleExpired(message)) throw new Error("Inspector console buffer expired");
    if (consoleFailure(message, context === "page")) this.ledger?.consoleMessage(context, message);
  }
  private workerMessage(params: Record<string, unknown>): void {
    if (typeof params.workerId !== "string" || typeof params.message !== "string")
      throw new Error("Invalid Inspector worker console envelope");
    this.ledger?.workerIdentity(params.workerId);
    const message = parseMessage(params.message);
    if (message.kind === "reply")
      return this.reply(message, { kind: "worker", id: params.workerId });
    if (message.method === "Console.messageAdded")
      this.consoleEvent(params.workerId, message.params);
  }
  private enableWorkerConsole(id: string): Promise<unknown> {
    const worker = this.ledger?.workerIdentity(id);
    if (!worker) throw new Error("Missing console worker identity");
    const state: WorkerConsole = { worker, enableWritten: ++this.order };
    this.workerConsole.set(id, state);
    const replyID = this.nextID++;
    const pending: Pending = {
      ...Promise.withResolvers<unknown>(),
      route: { kind: "worker", id },
      reduced: () => {
        state.replied = ++this.order;
      },
    };
    this.pending.set(replyID, pending);
    const forwarded = this.command(
      "Worker.sendMessageToWorker",
      {
        workerId: id,
        message: JSON.stringify({ id: replyID, method: "Console.enable", params: {} }),
      },
      false,
      () => {
        state.forwarded = ++this.order;
      },
      () => {
        state.forwardingOuter = ++this.order;
      },
    );
    return bounded(Promise.all([pending.promise, forwarded]), 3000, "Worker Console.enable").catch(
      (error: unknown) => {
        this.lose(error);
        throw error;
      },
    );
  }
  private settleConsole(): Promise<void> {
    if (!this.binding.console || !this.ledger)
      return Promise.reject(new Error("Console observation not enabled"));
    // This page reply cuts off the observed stream. It does not drain independent workers.
    return (this.consoleCutoff ??= this.command("Console.enable", {}, false, () =>
      this.ledger?.consoleState.freeze(),
    ).then(() => {}));
  }
  private command(
    method: Command,
    params: Record<string, unknown>,
    cleanup = false,
    reduced?: () => void,
    outerReduced?: () => void,
  ): Promise<unknown> {
    return this.binding.consumers.invoke(async () => {
      this.check(cleanup);
      const id = this.nextID++,
        outer = this.nextID++;
      const pending: Pending = {
        ...Promise.withResolvers<unknown>(),
        route: { kind: "page" },
        reduced,
      };
      this.pending.set(id, pending);
      const forwarded: Pending = {
        ...Promise.withResolvers<unknown>(),
        route: { kind: "target" },
        reduced: outerReduced,
      };
      this.pending.set(outer, forwarded);
      const data = JSON.stringify({
        id: outer,
        method: "Target.sendMessageToTarget",
        params: {
          targetId: this.target,
          message: JSON.stringify({ id, method, params }),
        },
      });
      const sent = this.send(
        "_rpc_forwardSocketData:",
        { ...this.arguments(), WIRSocketDataKey: Buffer.from(data) },
        cleanup,
      );
      try {
        const [answer] = await bounded(
          Promise.all([pending.promise, forwarded.promise, sent]),
          3000,
          `Inspector ${method}`,
        );
        return answer;
      } catch (error) {
        this.lose(
          new Error(`Inspector ${method} completion uncertain or refused`, { cause: error }),
        );
        throw error;
      }
    });
  }
  close(): Promise<void> {
    return (this.closeWork ??= this.binding.consumers.invoke(() => this.closeOnce()));
  }
  private async closeOnce(): Promise<void> {
    this.dispatchOpen = false;
    if (this.abort) this.binding.signal.removeEventListener("abort", this.abort);
    try {
      await Promise.all(Array.from(this.initializations));
      if (this.targetRetired) return;
      if (this.enabledNetwork) await this.command("Network.disable", {}, true);
      if (this.enabledWorker) await this.command("Worker.disable", {}, true);
      if (this.enabledConsole) await this.command("Console.disable", {}, true);
      if (this.enabledPage) await this.command("Page.disable", {}, true);
      if (this.attached && !this.failed) await this.detach();
      if (this.failed) throw this.failed;
    } finally {
      await this.transport?.close();
    }
  }
  private async detach(): Promise<void> {
    this.detaching = true;
    // A local socket close is not detach acknowledgement. Require the exact page listing to clear.
    const confirmation = this.waitDetach();
    await this.send("_rpc_forwardDidClose:", this.arguments(), true);
    await this.send(
      "_rpc_forwardGetListing:",
      {
        WIRConnectionIdentifierKey: this.connection,
        WIRApplicationIdentifierKey: this.selection?.application ?? "",
      },
      true,
    );
    await confirmation;
  }
  private async waitDetach(): Promise<void> {
    const waiter: MetadataWait = {
      match: () => this.detachConfirmed,
      pending: Promise.withResolvers<InspectorEnvelope>(),
    };
    this.metadata.add(waiter);
    try {
      await bounded(waiter.pending.promise, 3000, "Exact Inspector detach acknowledgement");
    } finally {
      this.metadata.delete(waiter);
    }
  }
}
