import { createRuntime } from "../index.js";
import { NetHost } from "../browser/net/host.js";
import { createRing } from "../browser/net/ring.js";

/** Additional activation proof; the complete original network cases remain unchanged. */
export async function bufferNetworkActivation(): Promise<string> {
  const Memory = WebAssembly.Memory,
    Instance = WebAssembly.Instance;
  let memories = 0,
    instances = 0;
  WebAssembly.Memory = class extends Memory {
    constructor(...args: ConstructorParameters<typeof Memory>) {
      super(...args);
      memories++;
    }
  };
  WebAssembly.Instance = class extends Instance {
    constructor(...args: ConstructorParameters<typeof Instance>) {
      super(...args);
      instances++;
    }
  };
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "/network-fs.js" } });
  let host: NetHost | undefined;
  try {
    const network = await runtime.network(),
      ring = createRing();
    const helper = network.createHelper({
      ring,
      fetch: async () => {
        throw Error("External fetch forbidden");
      },
    });
    host = new NetHost(ring, (request) => helper.handle(request), undefined, { shared: true });
    const listener = host.listen("127.0.0.1", 32124),
      client = host.connect("localhost", 32124);
    const server = await progress(() => host?.accept(listener) ?? -2);
    const bytes = new Uint8Array([11, 22, 33]);
    if (host.write(client, bytes) !== 3) throw Error("Activation traffic write failed");
    const result = await progress(() => host?.read(server, 3) ?? -2);
    if (
      !(result instanceof Uint8Array) ||
      result.length !== 3 ||
      !result.every((byte, index) => byte === bytes[index])
    )
      throw Error("Activation traffic bytes differ");
    if (memories || instances)
      throw Error(`Network constructed ${memories} memories and ${instances} instances`);
    if (
      performance
        .getEntriesByType("resource")
        .some((entry) => /network\.wasm(?:$|[?#])/.test(entry.name))
    )
      throw Error("Network requested network.wasm");
    return "runtime activation and loopback traffic construct zero WebAssembly.Memory/Instance and request no network.wasm";
  } finally {
    host?.dispose();
    await runtime.dispose().finally(() => {
      WebAssembly.Memory = Memory;
      WebAssembly.Instance = Instance;
    });
  }
}
async function progress<T extends number | Uint8Array>(read: () => T): Promise<T> {
  for (let round = 0; round < 300; round++) {
    const value = read();
    if (value !== -2) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Activation traffic timed out");
}
