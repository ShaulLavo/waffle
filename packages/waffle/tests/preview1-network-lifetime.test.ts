import { expect, test } from "bun:test";
import { createPreview1Network } from "../browser/preview1-network.js";
import { createRuntimeNetwork, type RuntimeNetworkHelper } from "../browser/net/runtime.js";

// A port task can already have selected its callback when the launch closes the port.
test("a queued relay socket request cannot enter a disposed Preview 1 helper", async () => {
  const owner = await createRuntimeNetwork(() => {});
  const NativeChannel = globalThis.MessageChannel;
  let receiver: MessagePort | undefined;
  let helper: RuntimeNetworkHelper | undefined;
  let launch: Awaited<ReturnType<typeof createPreview1Network>>;
  globalThis.MessageChannel = class extends NativeChannel {
    constructor() {
      super();
      receiver = this.port1;
    }
  };
  try {
    launch = await createPreview1Network(
      {
        network: async () => ({
          ...owner.network,
          createHelper(options) {
            helper = owner.network.createHelper(options);
            return helper;
          },
        }),
      },
      { sockets: [{ fd: 3, socket: { connect: { host: "echo.waffle.test", port: 9000 } } }] },
    );
    if (!launch || !receiver || !helper) throw new Error("Missing real network launch");
    const callback = receiver.onmessage;
    if (!callback) throw new Error("Missing launch request dispatcher");
    const reply = new SharedArrayBuffer(12);
    callback.call(receiver, new MessageEvent("message", {
      data: { type: "tcp-listen", id: 1, host: "localhost", port: 0, reply },
    }));
    expect(Atomics.load(new Int32Array(reply), 1)).toBe(0);
    launch.dispose();
    const late = new MessageEvent("message", { data: { type: "close", id: 1 } });
    expect(() => callback.call(receiver, late)).not.toThrow();
    expect(() => helper.handle(late.data)).toThrow("Network helper is disposed");
    launch.dispose();
  } finally {
    globalThis.MessageChannel = NativeChannel;
    launch?.dispose();
    await owner.dispose();
  }
});
