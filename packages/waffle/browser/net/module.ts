/** Explicit standalone loader. Importing this file does not fetch, compile or instantiate WASM. */
export async function loadNetworkModule(url = new URL("./network.wasm", import.meta.url)) {
  const module = await compile(url);
  return Object.freeze({
    create(
      io: (
        operation: number,
        socket: number,
        pointer: number,
        length: number,
        memory: WebAssembly.Memory,
      ) => number = () => -10,
    ) {
      const instance = new WebAssembly.Instance(module, {
        waffle_tcp_host: {
          io(operation: number, socket: number, pointer: number, length: number) {
            return io(operation, socket, pointer, length, memory);
          },
        },
      });
      const exported = instance.exports.memory;
      if (!(exported instanceof WebAssembly.Memory))
        throw new TypeError("Network module has no memory");
      const memory = exported;
      let disposed = false;
      function call(name: string, ...args: number[]): number {
        if (disposed) throw new Error("Network module is disposed");
        const fn = instance.exports[name];
        if (typeof fn !== "function") throw new TypeError(`Unknown network operation ${name}`);
        const value: unknown = fn(...args);
        if (typeof value !== "number") throw new TypeError("Invalid network result");
        return value;
      }
      function buffer(length: number): Uint8Array<ArrayBuffer> {
        const capacity = call("tcp_capacity");
        if (!Number.isInteger(length) || length < 0 || length > capacity)
          throw new RangeError("Network buffer length");
        const pointer = call("tcp_buffer");
        return new Uint8Array(memory.buffer, pointer, length);
      }
      return {
        call,
        capacity: call("tcp_capacity"),
        write(name: string, id: number, bytes: Uint8Array): number {
          buffer(bytes.length).set(bytes);
          return call(name, id, bytes.length);
        },
        read(name: string, id: number, length: number): Uint8Array | number {
          buffer(length);
          const count = call(name, id, length);
          return count < 0 ? count : buffer(count).slice();
        },
        address(id: number, peer = false): Uint8Array {
          const result = call("net_address", id, peer ? 1 : 0);
          if (result < 0) throw new Error(`Invalid network address token ${id}`);
          return buffer(32).slice();
        },
        dispose() {
          if (disposed) return;
          call("tcp_dispose");
          disposed = true;
        },
      };
    },
  });
}
export type NetworkModule = ReturnType<Awaited<ReturnType<typeof loadNetworkModule>>["create"]>;

async function compile(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol !== "file:") return WebAssembly.compileStreaming(fetch(url));
  // A variable import keeps Node's file adapter out of browser bundles.
  const name = "node:fs/promises";
  const files: typeof import("node:fs/promises") = await import(name);
  return WebAssembly.compile(await files.readFile(url));
}
