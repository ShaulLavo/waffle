import { networkOwner } from "./owner.js";
import type { BufferExports } from "./network.buffer.js";

/** Terminal: translated Rust may be mid-update and must never be entered again. */
export class NetworkOwnerFailure extends Error {
  readonly callbackErrors: unknown[] = [];
  constructor(cause: unknown) {
    super("Network module failed", { cause });
    this.name = "NetworkOwnerFailure";
  }
}

/** Page realm only. Importing this loader does not load or instantiate the factory. */
export async function loadBufferNetworkModule() {
  const { instantiate } = await import("./network.buffer.js");
  return Object.freeze({ create: () => create(instantiate) });
}

function create(instantiate: typeof import("./network.buffer.js").instantiate) {
  let live: BufferExports | undefined;
  let failure: NetworkOwnerFailure | undefined;
  /** The only boundary into translated execution, including factory initialization. */
  function enter<T>(operation: () => T): T {
    if (failure) throw failure;
    try {
      return operation();
    } catch (cause) {
      failure = new NetworkOwnerFailure(cause);
      live = undefined;
      throw failure;
    }
  }
  function exports(): BufferExports {
    if (failure) throw failure;
    if (!live) throw new Error("Network module is disposed");
    return live;
  }
  function validate(name: string): void {
    if (!name.startsWith("net_") || typeof exports()[name] !== "function")
      throw new TypeError(`Unknown network operation ${name}`);
  }
  function invoke(name: string, args: number[]): number {
    const fn = exports()[name];
    if (typeof fn !== "function") throw new TypeError(`Unknown network operation ${name}`);
    const value: unknown = enter(() => fn(...args));
    if (typeof value !== "number") throw new TypeError("Invalid network result");
    return value;
  }
  function release(): void {
    try {
      if (!failure) invoke("tcp_dispose", []);
    } catch {
      // enter recorded the failure. The virtual-only owner holds no native resource.
    } finally {
      live = undefined;
    }
  }
  live = enter(() => instantiate({ waffle_tcp_host: { io: () => -10 } }));
  // Force fixed metadata and scratch allocation during activation, before any socket exists.
  invoke("tcp_buffer", []);
  const owner = networkOwner(invoke, () => exports().memory.buffer, validate, release);
  return Object.assign(owner, { failure: () => failure });
}
export type BufferNetworkModule = ReturnType<typeof create>;
