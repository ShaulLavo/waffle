import { expect, test } from "bun:test";
import {
  OpenHeaderDecoder,
  TcpState,
  encodeOpenHeader,
  frameCredit,
  frameData,
  parseFrame,
  parseOpen,
  parseReply,
} from "../src/tcp-protocol.js";

test("incremental length, UTF-8 header and first payload across every split", () => {
  const request = {
    v: 1,
    token: "test-token",
    host: "bücher.example",
    port: 80,
    window: 262144,
  } as const;
  const header = encodeOpenHeader(request);
  const bytes = new Uint8Array(header.length + 3);
  bytes.set(header);
  bytes.set([9, 8, 7], header.length);
  for (let split = 0; split < header.length; split++) {
    const decoder = new OpenHeaderDecoder();
    expect(decoder.push(bytes.subarray(0, split))).toBeUndefined();
    const decoded = decoder.push(bytes.subarray(split))!;
    expect(parseOpen(decoded.header)).toEqual(request);
    expect(Array.from(decoded.rest)).toEqual([9, 8, 7]);
    expect(() => decoder.push(new Uint8Array())).toThrow("protocol");
  }
  const bytewise = new OpenHeaderDecoder();
  let result;
  for (const byte of header) result = bytewise.push(new Uint8Array([byte]));
  expect(parseOpen(result!.header)).toEqual(request);
});
test("rejects malformed lengths before allocating, malformed UTF-8/JSON and replies", () => {
  expect(() => new OpenHeaderDecoder().push(new Uint8Array([32, 1]))).toThrow();
  expect(() => new OpenHeaderDecoder().push(new Uint8Array([0, 0]))).toThrow();
  expect(() => new OpenHeaderDecoder().push(new Uint8Array([0, 1, 255]))).toThrow();
  expect(() => parseOpen("{}")).toThrow();
  expect(() => parseReply('{"v":1,"ok":true,"remote":{}}')).toThrow();
  expect(() => parseOpen("x".repeat(8193))).toThrow();
});
test("strict phase, credit accounting, directional FIN and one terminal transition", () => {
  const state = new TcpState(16384);
  expect(() => state.receive(parseFrame(frameData(new Uint8Array([1]))))).toThrow();
  state.open(16384);
  state.send(16384);
  expect(state.sendCredit).toBe(0);
  expect(() => state.send(1)).toThrow();
  expect(() => state.receive({ kind: "credit", bytes: 16385 })).toThrow();
  state.receive(parseFrame(frameCredit(16384)));
  expect(state.sendCredit).toBe(16384);
  expect(() => state.receive(parseFrame(frameCredit(1)))).toThrow();
  expect(() => state.receive(parseFrame(frameCredit(0)))).toThrow();
  state.receive({ kind: "data", bytes: new Uint8Array(16384) });
  expect(state.receiveCredit).toBe(0);
  expect(() => state.receive({ kind: "data", bytes: new Uint8Array(1) })).toThrow();
  state.receive({ kind: "fin" });
  state.fin();
  expect(state.drained).toBe(false);
  expect(() => state.receive({ kind: "fin" })).toThrow();
  expect(() => state.receive({ kind: "data", bytes: new Uint8Array(1) })).toThrow();
  expect(() => state.fin()).toThrow();
  state.consumed(16384);
  state.creditHanded(16384);
  expect(state.drained).toBe(true);
  expect(state.close()).toBe(true);
  expect(state.close()).toBe(false);
  expect(() => state.open(16384)).toThrow();
});
test("rejects invalid frames and oversized data", () => {
  for (const bytes of [[], [3], [0], [1, 2], [2, 1], Array.from({ length: 65538 }, () => 0)])
    expect(() => parseFrame(new Uint8Array(bytes))).toThrow();
  expect(() => frameData(new Uint8Array(65537))).toThrow();
});
