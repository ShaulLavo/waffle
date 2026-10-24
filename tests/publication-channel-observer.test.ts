import { expect, test } from "bun:test";
import { installWorkspaceChannelObserver } from "./fixtures/publication-channel-observer";

function observerControl(exercise: (channel: BroadcastChannel, state: object) => void): void {
  const native = globalThis.BroadcastChannel;
  const ports = globalThis.MessageChannel;
  const previous: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
  class Channel extends EventTarget {
    constructor(readonly name: string) {
      super();
    }
    postMessage(_value: unknown): void {}
    close(): void {}
  }
  Reflect.set(globalThis, "BroadcastChannel", Channel);
  try {
    installWorkspaceChannelObserver();
    const channel = new BroadcastChannel("waffle:resident:observer-control");
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    if (!state || typeof state !== "object") throw new Error("missing observer");
    exercise(channel, state);
    channel.close();
  } finally {
    globalThis.BroadcastChannel = native;
    globalThis.MessageChannel = ports;
    Reflect.set(globalThis, "__workspaceChannelCounts", previous);
  }
}
function deliver(channel: BroadcastChannel, value: unknown): void {
  channel.dispatchEvent(new MessageEvent("message", { data: value }));
}

test("workspace barrier withholds both terminal deliveries for the original client and request", () => {
  observerControl((channel, state) => {
    const received: unknown[] = [];
    channel.addEventListener("message", ({ data }: MessageEvent<unknown>) => received.push(data));
    const identity = { client: "original-client", id: "original-request" };
    channel.postMessage({ kind: "request", ...identity, operation: "workspace" });
    Reflect.set(state, "hold", "workspace");
    const reply = { kind: "reply", ...identity, value: null };
    deliver(channel, reply);
    const terminal = { kind: "reconcileReply", ...identity, state: "terminal", value: null };
    deliver(channel, terminal);
    expect(received).toEqual([]);
    expect(Reflect.get(state, "pending")).toBe(1);
    expect(Reflect.get(state, "held")).toBe(2);
    const release: unknown = Reflect.get(state, "release");
    if (typeof release !== "function") throw new Error("missing release");
    release();
    expect(received).toEqual([reply, terminal]);
    expect(Reflect.get(state, "pending")).toBe(0);
    expect(Reflect.get(state, "held")).toBe(0);
    channel.close();
    expect(Reflect.get(state, "closedPending")).toBe(0);
  });
});

test("terminal reconciliation accounts for a lost ordinary reply before channel close", () => {
  observerControl((channel, state) => {
    const identity = { client: "original-client", id: "original-request" };
    channel.postMessage({ kind: "request", ...identity, operation: "workspaceAdopt" });
    deliver(channel, { kind: "reconcileReply", ...identity, state: "pending" });
    expect(Reflect.get(state, "pending")).toBe(1);
    deliver(channel, { kind: "reconcileReply", ...identity, state: "unknown" });
    expect(Reflect.get(state, "pending")).toBe(1);
    deliver(channel, { kind: "reconcileReply", ...identity, state: "terminal", errno: 11 });
    expect(Reflect.get(state, "pending")).toBe(0);
    deliver(channel, { kind: "reply", ...identity, errno: 11 });
    expect(Reflect.get(state, "pending")).toBe(0);
    channel.close();
    expect(Reflect.get(state, "closedPending")).toBe(0);
  });
});

test("same request id from another client cannot settle the observed original request", () => {
  observerControl((channel, state) => {
    const identity = { client: "original-client", id: "original-request" };
    channel.postMessage({ kind: "request", ...identity, operation: "workspace" });
    deliver(channel, { kind: "reply", ...identity, client: "other-client", value: null });
    expect(Reflect.get(state, "pending")).toBe(1);
    deliver(channel, {
      kind: "reconcileReply",
      ...identity,
      client: "other-client",
      state: "terminal",
      value: null,
    });
    expect(Reflect.get(state, "pending")).toBe(1);
    deliver(channel, { kind: "reply", ...identity, value: null });
    expect(Reflect.get(state, "pending")).toBe(0);
  });
});
