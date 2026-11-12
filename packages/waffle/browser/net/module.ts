import { networkOwner } from "./owner.js";
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
      function invoke(name: string, args: number[]): number {
        const fn = instance.exports[name];
        if (typeof fn !== "function") throw new TypeError(`Unknown network operation ${name}`);
        const value: unknown = fn(...args);
        if (typeof value !== "number") throw new TypeError("Invalid network result");
        return value;
      }
      return networkOwner(invoke, () => memory.buffer);
    },
  });
}
export type { NetworkModule } from "./owner.js";

async function compile(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol !== "file:") return WebAssembly.compileStreaming(fetch(url));
  // A variable import keeps Node's file adapter out of browser bundles.
  const name = "node:fs/promises";
  const files: typeof import("node:fs/promises") = await import(name);
  return WebAssembly.compile(await files.readFile(url));
}
