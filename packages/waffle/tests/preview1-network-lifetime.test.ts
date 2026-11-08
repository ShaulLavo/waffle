import { expect, test } from "bun:test";
import { createPreview1Network } from "../browser/preview1-network.js";
import {
  createRuntimeNetwork,
  type RuntimeNetwork,
  type RuntimeNetworkHelper,
} from "../browser/net/runtime.js";

// A port task can already have selected its callback when the launch closes the port.
test("a queued relay socket request cannot enter a disposed Preview 1 helper", async () => {
  let ownerFailure: Error | undefined;
  const owner = await createRuntimeNetwork(() => {
    if (ownerFailure) throw ownerFailure;
  });
  const NativeChannel = globalThis.MessageChannel;
  let receiver: MessagePort | undefined;
  let helper: RuntimeNetworkHelper | undefined;
  let launch: Awaited<ReturnType<typeof createPreview1Network>>;
  const network = {
    ...owner.network,
    createHelper(options: Parameters<RuntimeNetwork["createHelper"]>[0]) {
      helper = owner.network.createHelper(options);
      return helper;
    },
  };
  globalThis.MessageChannel = class extends NativeChannel {
    constructor() {
      super();
      receiver = this.port1;
    }
  };
  try {
    launch = await createPreview1Network(
      { network: async () => network },
      { sockets: [{ fd: 3, socket: { connect: { host: "echo.waffle.test", port: 9000 } } }] },
    );
    if (!launch || !receiver || !helper) throw new Error("Missing real network launch");
    const port = receiver;
    const launchHelper = helper;
    const callback = port.onmessage;
    if (!callback) throw new Error("Missing launch request dispatcher");
    const reply = new SharedArrayBuffer(12);
    const cells = new Int32Array(reply);
    cells.fill(-1);
    callback.call(
      port,
      new MessageEvent("message", {
        data: { type: "tcp-listen", id: 1, host: "localhost", port: 0, reply },
      }),
    );
    expect(Atomics.load(cells, 0)).toBe(1);
    expect(Atomics.load(cells, 1)).toBe(0);
    expect(Atomics.load(cells, 2)).toBeGreaterThan(0);
    ownerFailure = new Error("active helper owner failure");
    expect(() =>
      callback.call(port, new MessageEvent("message", { data: { type: "close", id: 1 } })),
    ).toThrow(ownerFailure);
    ownerFailure = undefined;
    launch.dispose();
    const late = new MessageEvent("message", { data: { type: "close", id: 1 } });
    expect(() => callback.call(port, late)).not.toThrow();
    expect(() => launchHelper.handle(late.data)).toThrow("Network helper is disposed");
    launch.dispose();
  } finally {
    ownerFailure = undefined;
    globalThis.MessageChannel = NativeChannel;
    launch?.dispose();
    await owner.dispose();
  }
});
