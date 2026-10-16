import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createNodeNet } from "../scripts/node-net.mjs";

class QueuedSocket extends EventEmitter {
  connecting = false;
  writableLength = 0;
  writes: Uint8Array[] = [];
  write(bytes: Uint8Array) {
    this.writes.push(bytes);
    this.writableLength += bytes.length;
    return false;
  }
  end() {}
}

function fixture() {
  const socket = new QueuedSocket();
  const { natives } = createNodeNet({ net: { connect: () => socket } });
  return { socket, natives, handle: natives.hostConnect("127.0.0.1", 1234) };
}

test("Node host writes stop at available queue capacity", () => {
  const { socket, natives, handle } = fixture();
  const capacity = 1 << 20;
  const bytes = new Uint8Array(capacity * 2).fill(7);
  expect(natives.hostWrite(handle, bytes)).toBe(capacity);
  expect(socket.writableLength).toBe(capacity);
  expect(natives.hostWrite(handle, bytes)).toBe(-2);
  expect(socket.writes.length).toBe(1);
  expect(natives.hostWrite(handle, new Uint8Array())).toBe(0);
  socket.writableLength = capacity - 3;
  expect(natives.hostWrite(handle, bytes)).toBe(3);
  bytes.fill(9);
  expect(Array.from(socket.writes[1])).toEqual([7, 7, 7]);
  expect(natives.hostClose(handle)).toBe(0);
});
