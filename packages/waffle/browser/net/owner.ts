/** Shared scratch ABI for the native-Wasm and translated private owners. */
export function networkOwner(
  invoke: (name: string, args: number[]) => number,
  memory: () => ArrayBuffer,
  validate: (name: string) => void = () => {},
  release: () => void = () => {
    invoke("tcp_dispose", []);
  },
) {
  let disposed = false;
  const capacity = invoke("tcp_capacity", []);
  function check(name: string): void {
    if (disposed) throw new Error("Network module is disposed");
    validate(name);
  }
  function call(name: string, ...args: number[]): number {
    check(name);
    return invoke(name, args);
  }
  function buffer(length: number): Uint8Array<ArrayBuffer> {
    if (!Number.isInteger(length) || length < 0 || length > capacity)
      throw new RangeError("Network buffer length");
    const pointer = invoke("tcp_buffer", []);
    return new Uint8Array(memory(), pointer, length);
  }
  return {
    call,
    capacity,
    write(name: string, id: number, bytes: Uint8Array): number {
      check(name);
      buffer(bytes.length).set(bytes);
      return invoke(name, [id, bytes.length]);
    },
    read(name: string, id: number, length: number): Uint8Array | number {
      check(name);
      buffer(length);
      const count = invoke(name, [id, length]);
      return count < 0 ? count : buffer(count).slice();
    },
    address(id: number, peer = false): Uint8Array {
      const result = call("net_address", id, peer ? 1 : 0);
      if (result < 0) throw new Error(`Invalid network address token ${id}`);
      return buffer(32).slice();
    },
    dispose(): void {
      if (disposed) return;
      try {
        release();
      } finally {
        disposed = true;
      }
    },
  };
}
export type NetworkModule = ReturnType<typeof networkOwner>;
