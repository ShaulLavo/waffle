/** Test-only native channel delivery barriers, installed before the page imports production. */
export function installWorkspaceChannelObserver(): void {
  const state = {
    opened: 0,
    closed: 0,
    pending: 0,
    held: 0,
    closedPending: 0,
    cancelled: 0,
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
  const held = new Map<MessageEvent<unknown>, ObservedChannel>();
  class ObservedChannel extends NativeChannel {
    private closed = false;
    private requests = new Map<string, string>();
    constructor(name: string) {
      super(name);
      if (name.startsWith("waffle:resident:")) state.opened++;
      this.addEventListener("message", (event: MessageEvent<unknown>) => this.receive(event));
    }
    postMessage(value: unknown): void {
      const data = message(value);
      if (data?.kind === "request" && typeof data.id === "string")
        this.track(data.id, data.operation);
      if (data?.kind === "cancel" && typeof data.id === "string" && this.requests.has(data.id))
        state.cancelled++;
      super.postMessage(value);
    }
    private track(id: string, operation: unknown): void {
      if (operation !== "workspace" && operation !== "workspaceAdopt") return;
      this.requests.set(id, operation);
      state.pending++;
    }
    private receive(event: MessageEvent<unknown>): void {
      const data = message(event.data);
      if (data?.kind !== "reply" || typeof data.id !== "string") return;
      const operation = this.requests.get(data.id);
      if (!operation) return;
      if (state.hold === operation) {
        state.hold = "";
        event.stopImmediatePropagation();
        held.set(event, this);
        state.held++;
        return;
      }
      this.requests.delete(data.id);
      state.pending--;
    }
    close(): void {
      if (!this.closed && this.name.startsWith("waffle:resident:")) state.closed++;
      if (!this.closed && this.requests.size) state.closedPending++;
      this.closed = true;
      super.close();
    }
  }
  function message(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") return;
    return Object.fromEntries(Object.entries(value));
  }
  state.release = () => {
    const events = Array.from(held);
    held.clear();
    state.held = 0;
    for (const [event, channel] of events)
      channel.dispatchEvent(new MessageEvent("message", { data: event.data }));
  };
  const heldConnections: { port: MessagePort; event: MessageEvent<unknown> }[] = [];
  state.releaseConnect = () => {
    state.connectHeld = 0;
    for (const { port, event } of heldConnections.splice(0))
      port.dispatchEvent(new MessageEvent("message", { data: event.data }));
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
    if (data?.stopWorkspace instanceof MessagePort) state.cleanupStarted++;
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
