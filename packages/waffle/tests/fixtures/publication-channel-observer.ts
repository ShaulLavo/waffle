/** Test-only native channel delivery barriers, installed before the page imports production. */
export function installWorkspaceChannelObserver(): void {
  const state = {
    opened: 0,
    closed: 0,
    pending: 0,
    held: 0,
    closedPending: 0,
    cancelled: 0,
    reconciled: 0,
    cleanupStarted: 0,
    connectHeld: 0,
    connectReceived: 0,
    connectDelivered: 0,
    connectOpened: 0,
    releaseConnect: () => {},
    hold: "",
    release: () => {},
  };
  const NativeChannel = BroadcastChannel;
  type Request = { operation: string; held: boolean };
  const held = new Map<MessageEvent<unknown>, { channel: ObservedChannel; request: Request }>();
  class ObservedChannel extends NativeChannel {
    private closed = false;
    private requests = new Map<string, Request>();
    constructor(name: string) {
      super(name);
      if (name.startsWith("waffle:resident:")) state.opened++;
      this.addEventListener("message", (event: MessageEvent<unknown>) => this.receive(event));
    }
    postMessage(value: unknown): void {
      const data = message(value);
      const key = identity(data);
      if (data?.kind === "request" && key) this.track(key, data.operation);
      if (data?.kind === "cancel" && key && this.requests.has(key)) state.cancelled++;
      super.postMessage(value);
    }
    private track(key: string, operation: unknown): void {
      if (operation !== "workspace" && operation !== "workspaceAdopt") return;
      this.requests.set(key, { operation, held: false });
      state.pending++;
    }
    private receive(event: MessageEvent<unknown>): void {
      const data = message(event.data);
      if (data?.kind !== "reply" && !(data?.kind === "reconcileReply" && data.state === "terminal"))
        return;
      const key = identity(data);
      if (!key) return;
      const request = this.requests.get(key);
      if (!request) return;
      if (data.kind === "reconcileReply") state.reconciled++;
      if (state.hold === request.operation) {
        state.hold = "";
        request.held = true;
      }
      if (request.held) {
        event.stopImmediatePropagation();
        held.set(event, { channel: this, request });
        state.held++;
        return;
      }
      this.requests.delete(key);
      state.pending--;
    }
    close(): void {
      if (!this.closed && this.name.startsWith("waffle:resident:")) state.closed++;
      if (!this.closed && this.requests.size) state.closedPending++;
      this.closed = true;
      super.close();
    }
  }
  function identity(data: Record<string, unknown> | undefined): string | undefined {
    if (typeof data?.client !== "string" || typeof data.id !== "string") return;
    return JSON.stringify([data.client, data.id]);
  }
  function message(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") return;
    return Object.fromEntries(Object.entries(value));
  }
  state.release = () => {
    const events = Array.from(held);
    held.clear();
    state.held = 0;
    for (const [event, { channel, request }] of events) {
      request.held = false;
      channel.dispatchEvent(new MessageEvent("message", { data: event.data }));
    }
  };
  const heldConnections: { port: MessagePort; event: MessageEvent<unknown> }[] = [];
  const heldAdmissions: (() => void)[] = [];
  const deliverAdmission = (admit: () => void) => {
    const opened = state.opened;
    admit();
    state.connectDelivered++;
    queueMicrotask(() => {
      state.connectOpened += state.opened - opened;
    });
  };
  Reflect.set(state, "admitConnect", (admit: () => void) => {
    state.connectReceived++;
    if (state.hold !== "connect") {
      deliverAdmission(admit);
      return;
    }
    state.hold = "";
    heldAdmissions.push(admit);
    state.connectHeld++;
  });
  state.releaseConnect = () => {
    state.connectHeld = 0;
    for (const { port, event } of heldConnections.splice(0))
      port.dispatchEvent(new MessageEvent("message", { data: event.data }));
    for (const admit of heldAdmissions.splice(0)) deliverAdmission(admit);
  };
  const NativePorts = MessageChannel;
  class ObservedPorts extends NativePorts {
    constructor() {
      super();
      this.port1.addEventListener("message", observeCleanup);
      this.port2.addEventListener("message", observeCleanup);
    }
  }
  function observeCleanup(this: MessagePort, event: MessageEvent<unknown>): void {
    const data = message(event.data);
    if (data?.stopWorkspace === true) state.cleanupStarted++;
    if (!data || !("connect" in data)) return;
    state.connectReceived++;
    if (state.hold === "connect") {
      state.hold = "";
      event.stopImmediatePropagation();
      heldConnections.push({ port: this, event });
      state.connectHeld++;
      return;
    }
    const opened = state.opened;
    state.connectDelivered++;
    queueMicrotask(() => {
      state.connectOpened += state.opened - opened;
    });
  }
  globalThis.MessageChannel = ObservedPorts;
  globalThis.BroadcastChannel = ObservedChannel;
  Reflect.set(globalThis, "__workspaceChannelCounts", state);
}
