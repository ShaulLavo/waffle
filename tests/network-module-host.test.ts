import { expect, test } from "bun:test";
import { loadNetworkModule, type NetworkModule } from "../browser/net/module.js";

function endpoint(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 4, true);
  data.setUint32(4, 12345, true);
  bytes.set([127, 0, 0, 1], 8);
  return bytes;
}

class ShortHost {
  id = 7;
  connected = false;
  writable = false;
  readBlocked = false;
  writeBlocked = false;
  incoming: number[] = [];
  sent: number[] = [];
  attempts: number[][] = [];
  closed: number[] = [];
  operations: number[] = [];
  lastRead: { memory: WebAssembly.Memory; pointer: number; length: number } | undefined;

  io(
    operation: number,
    id: number,
    pointer: number,
    length: number,
    memory: WebAssembly.Memory,
  ): number {
    this.operations.push(operation);
    switch (operation) {
      case 1:
        return this.id;
      case 5:
        return -1;
      case 6:
        return this.connected ? 0 : -1;
      case 8:
        return this.read(pointer, length, memory);
      case 9:
        return this.write(pointer, length, memory);
      case 11:
      case 12:
        new Uint8Array(memory.buffer, pointer, length).set(endpoint());
        return 32;
      case 13:
        this.closed.push(id);
        return 0;
      default:
        return 0;
    }
  }
  read(pointer: number, length: number, memory: WebAssembly.Memory): number {
    if (!this.incoming.length || this.readBlocked) {
      this.readBlocked = false;
      return -1;
    }
    const bytes = this.incoming.splice(0, Math.min(2, length));
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    this.lastRead = { memory, pointer, length: bytes.length };
    this.readBlocked = true;
    return bytes.length;
  }
  write(pointer: number, length: number, memory: WebAssembly.Memory): number {
    this.attempts.push(Array.from(new Uint8Array(memory.buffer, pointer, length)));
    if (!this.writable || this.writeBlocked) {
      this.writeBlocked = false;
      return -1;
    }
    this.sent = this.sent.concat(
      Array.from(new Uint8Array(memory.buffer, pointer, Math.min(2, length))),
    );
    this.writeBlocked = true;
    return Math.min(2, length);
  }
  overwriteHostScratch(): void {
    if (!this.lastRead) return;
    const { memory, pointer, length } = this.lastRead;
    new Uint8Array(memory.buffer, pointer, length).fill(255);
  }
}

function dial(owner: NetworkModule): number {
  return owner.write("tcp_connect", 0, endpoint());
}

test("actual WASM returns native local and peer addresses through the public owner", async () => {
  const host = new ShortHost();
  const owner = (await loadNetworkModule()).create(host.io.bind(host));
  try {
    const id = dial(owner);
    expect(owner.read("tcp_local_addr", id, 32)).toEqual(endpoint());
    host.connected = true;
    expect(owner.read("tcp_peer_addr", id, 32)).toEqual(endpoint());
  } finally {
    owner.dispose();
  }
});

test("actual WASM preserves FIFO and copies buffers across two-byte host operations and WouldBlock", async () => {
  const host = new ShortHost();
  const owner = (await loadNetworkModule()).create(host.io.bind(host));
  try {
    const id = dial(owner);
    expect(id).toBe(7);
    expect(owner.call("tcp_interests", id)).toBe(2);
    expect(owner.write("tcp_write", id, new Uint8Array([1]))).toBe(-1);
    expect(
      await readiness(owner, id, () => {
        host.connected = true;
      }),
    ).toBe(0);
    const first = new Uint8Array([1, 2, 3, 4]);
    expect(owner.write("tcp_write", id, first)).toBe(4);
    first.fill(99);
    expect(owner.write("tcp_write", id, new Uint8Array([5, 6]))).toBe(2);
    expect(host.sent).toEqual([]);
    host.writable = true;
    for (let turn = 0; turn < 6; turn++) expect(await readiness(owner, id, () => {})).toBe(0);
    expect(host.sent).toEqual([1, 2, 3, 4, 5, 6]);
    expect(host.attempts.slice(-6)).toEqual([
      [1, 2, 3, 4, 5, 6],
      [1, 2, 3, 4, 5, 6],
      [3, 4, 5, 6],
      [3, 4, 5, 6],
      [5, 6],
      [5, 6],
    ]);
    host.incoming = [11, 12, 13, 14];
    expect(owner.call("tcp_poll", id)).toBe(0);
    host.overwriteHostScratch();
    const received = owner.read("tcp_read", id, 1);
    expect(received).toEqual(new Uint8Array([11]));
    expect(owner.read("tcp_read", id, 3)).toEqual(new Uint8Array([12, 13, 14]));
    owner.write("tcp_write", id, new Uint8Array([77]));
    expect(received).toEqual(new Uint8Array([11]));
    expect(owner.call("tcp_read", id, 0)).toBe(0);
    expect(owner.call("tcp_write", id, 65537)).toBe(-2);
    expect(owner.call("tcp_read", id, 0xffffffff)).toBe(-2);
    expect(owner.call("tcp_write", 0xffff, 1)).toBe(-2);
  } finally {
    owner.dispose();
  }
  expect(host.closed).toEqual([7]);
});

test("late readiness cannot alias quarantined host tokens after close or raw ABI disposal", async () => {
  const compiled = await loadNetworkModule();
  const host = new ShortHost();
  host.connected = true;
  const owner = compiled.create(host.io.bind(host));
  const unrelated = compiled.create();
  try {
    const old = dial(owner);
    const delayed = readiness(owner, old, () => {
      host.incoming = [1, 2];
      host.writable = true;
    });
    expect(owner.call("tcp_close", old)).toBe(0);
    const before = host.operations.length;
    expect(await delayed).toBe(-2);
    expect(host.operations.length).toBe(before);
    expect(dial(owner)).toBe(-2);
    host.id = 8;
    expect(dial(owner)).toBe(8);
    const closed = host.closed.length;
    expect(dial(owner)).toBe(-2);
    expect(host.closed.length).toBe(closed);
    expect(owner.call("tcp_interests", 8)).toBe(2);
    const afterDisposal = readiness(owner, 8, () => {
      host.connected = false;
    });
    expect(owner.call("tcp_dispose")).toBe(0);
    const disposedOperations = host.operations.length;
    expect(await afterDisposal).toBe(-2);
    expect(host.operations.length).toBe(disposedOperations);
    expect(dial(owner)).toBe(-2);
    expect(unrelated.call("net_listen", 40, 12345)).toBe(12345);
  } finally {
    owner.dispose();
    unrelated.dispose();
  }
});

test("browser virtual commands never invoke OS resolve, bind or connect imports", async () => {
  const operations: number[] = [];
  const owner = (await loadNetworkModule()).create((operation) => {
    operations.push(operation);
    return -10;
  });
  try {
    expect(owner.call("net_listen", 40, 12345)).toBe(12345);
    expect(owner.call("net_connect", 0, 12345)).toBe(-10);
    const client = owner.call("net_connect", 4, 12345);
    expect(client).toBeGreaterThan(0);
    expect(owner.write("net_write", client, new Uint8Array([1]))).toBe(1);
    expect(operations).toEqual([]);
  } finally {
    owner.dispose();
  }
});

function readiness(owner: NetworkModule, id: number, change: () => void): Promise<number> {
  return new Promise((resolve) =>
    queueMicrotask(() => {
      change();
      resolve(owner.call("tcp_poll", id));
    }),
  );
}

test("compiled WASM write backpressure advances only after delivered host readiness", async () => {
  const host = new ShortHost();
  host.connected = true;
  const owner = (await loadNetworkModule()).create(host.io.bind(host));
  try {
    const id = dial(owner);
    const chunk = new Uint8Array(65536).fill(23);
    for (let n = 0; n < 16; n++) expect(owner.write("tcp_write", id, chunk)).toBe(65536);
    expect(owner.write("tcp_write", id, new Uint8Array([24]))).toBe(-1);
    expect(host.sent).toEqual([]);
    const delivered = readiness(owner, id, () => {
      host.writable = true;
    });
    expect(host.sent).toEqual([]);
    expect(await delivered).toBe(0);
    expect(host.sent).toEqual([23, 23]);
    expect(owner.write("tcp_write", id, new Uint8Array([24, 25]))).toBe(2);
    expect(owner.call("tcp_interests", id)).toBe(3);
  } finally {
    owner.dispose();
  }
});

test("actual WASM scratch bounds and consumption credit are independent of byte publication", async () => {
  const owner = (await loadNetworkModule()).create();
  try {
    expect(owner.call("net_listen", 40, 12345)).toBe(12345);
    const client = owner.call("net_connect", 4, 12345);
    const server = owner.call("net_peer", client);
    expect(owner.capacity).toBe(65536);
    expect(() => owner.read("net_take", server, -1)).toThrow(RangeError);
    expect(() => owner.read("net_take", server, 0.5)).toThrow(RangeError);
    expect(() => owner.read("net_take", server, 65537)).toThrow(RangeError);
    expect(owner.call("net_write", client, 65537)).toBe(-2);
    expect(owner.call("net_write", client, 0xffffffff)).toBe(-2);
    expect(owner.write("net_write", client, new Uint8Array())).toBe(0);
    const bytes = new Uint8Array(65536).fill(31);
    for (let n = 0; n < 16; n++) expect(owner.write("net_write", client, bytes)).toBe(65536);
    expect(owner.write("net_write", client, new Uint8Array([32]))).toBe(-1);
    expect(owner.read("net_take", server, 2)).toEqual(new Uint8Array([31, 31]));
    expect(owner.write("net_write", client, new Uint8Array([32]))).toBe(-1);
    expect(owner.call("net_consumed", server, 2)).toBe(1);
    expect(owner.write("net_write", client, new Uint8Array([32, 33, 34]))).toBe(2);
    expect(owner.write("net_write", client, new Uint8Array([34]))).toBe(-1);
  } finally {
    owner.dispose();
    owner.dispose();
  }
});
