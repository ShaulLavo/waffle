import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { ResponseParser, type ResponseHead } from "../browser/net/http1";
import { bufferKinds, callerSpan, withStrictDecoder } from "./fixtures/buffer-boundaries";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEAD_LIMIT = 64 * 1024;
const LINE_LIMIT = 8 * 1024;
const TRAILER_LIMIT = 64 * 1024;
const chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";

function fixture() {
  const heads: ResponseHead[] = [];
  const chunks: Uint8Array[] = [];
  const errors: string[] = [];
  let ended = 0;
  const parser = new ResponseParser({
    head: (head) => {
      heads.push(head);
    },
    data: (bytes) => {
      chunks.push(bytes);
    },
    error: (message) => {
      errors.push(message);
    },
    end: () => {
      ended++;
    },
  });
  return {
    parser,
    heads,
    chunks,
    errors,
    get ended() {
      return ended;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

function push(f: Fixture, text: string, fragmented = false) {
  const bytes = encoder.encode(text);
  if (!fragmented) return f.parser.push(bytes);
  for (let offset = 0; offset < bytes.length; offset += 997)
    f.parser.push(bytes.subarray(offset, offset + 997));
}

function failed(f: Fixture, message: string) {
  expect(f.errors).toHaveLength(1);
  expect(f.errors[0]).toContain(message);
  expect(f.parser.done).toBe(true);
  expect(f.ended).toBe(0);
  const delivered = f.chunks.length;
  push(f, chunked + "1\r\nx\r\n0\r\n\r\n");
  f.parser.end();
  expect(f.errors).toHaveLength(1);
  expect(f.chunks).toHaveLength(delivered);
  expect(f.ended).toBe(0);
}

function head(length: number, status = "200 OK") {
  const prefix = `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nX-Pad: `;
  return prefix + "a".repeat(length - prefix.length - 4) + "\r\n\r\n";
}

const metadataCases = [
  { name: "head", prefix: "", value: head(HEAD_LIMIT + 1), limit: HEAD_LIMIT },
  {
    name: "chunk-size",
    prefix: chunked,
    value: "0;" + "a".repeat(LINE_LIMIT - 3) + "\r\n",
    limit: LINE_LIMIT,
  },
  {
    name: "trailers",
    prefix: chunked + "0\r\n",
    value: "X: " + "a".repeat(TRAILER_LIMIT - 4) + "\r\n",
    limit: TRAILER_LIMIT,
  },
];

for (const item of metadataCases) {
  for (const fragmented of [false, true]) {
    for (const complete of [false, true]) {
      test(`WAF-003 rejects ${fragmented ? "fragmented" : "single-push"} ${complete ? "complete" : "unfinished"} oversized ${item.name}`, () => {
        const f = fixture();
        push(f, item.prefix);
        const value = complete ? item.value : "a".repeat(item.limit + 1);
        push(f, value, fragmented);
        failed(f, item.name);
        expect(f.heads).toHaveLength(item.name === "head" ? 0 : 1);
        expect(f.chunks).toHaveLength(0);
      });
    }
  }
}

for (const fragmented of [false, true]) {
  test(`WAF-003 accepts exact metadata ceilings with ${fragmented ? "fragmented" : "coalesced"} delimiters`, () => {
    const f = fixture();
    push(f, head(HEAD_LIMIT, "103 Early Hints"), fragmented);
    push(f, head(HEAD_LIMIT, "100 Continue"), fragmented);
    const prefix = chunked.slice(0, -2) + "X-Pad: ";
    push(f, prefix + "a".repeat(HEAD_LIMIT - prefix.length - 4) + "\r\n\r\n", fragmented);
    push(f, "0;" + "a".repeat(LINE_LIMIT - 4) + "\r\n", fragmented);
    push(f, "X: " + "a".repeat(TRAILER_LIMIT - 7) + "\r\n\r\n", fragmented);
    expect(f.errors).toEqual([]);
    expect(f.heads).toHaveLength(1);
    expect(f.ended).toBe(1);
    expect(f.parser.done).toBe(true);
  });
}

test("WAF-003 counts completed short trailers and the final delimiter", () => {
  const f = fixture();
  push(f, chunked + "0\r\n");
  for (let index = 0; index < TRAILER_LIMIT / 8; index++) push(f, "X: abc\r\n");
  expect(f.errors).toEqual([]);
  push(f, "\r");
  failed(f, "trailers");
});

test("WAF-003 accepts exactly bounded cumulative short trailers", () => {
  const f = fixture();
  push(f, chunked + "0\r\n" + "X: abc\r\n".repeat(TRAILER_LIMIT / 8 - 1) + "X: x\r\n\r\n");
  expect(f.errors).toEqual([]);
  expect(f.ended).toBe(1);
});

for (const framing of ["length", "close", "chunked"]) {
  test(`WAF-003 streams a coalesced ${framing} body larger than every metadata ceiling`, () => {
    const f = fixture();
    const body = "z".repeat(HEAD_LIMIT * 4);
    const header = framing === "length" ? `Content-Length: ${body.length}\r\n` : "";
    const response =
      framing === "chunked"
        ? chunked + body.length.toString(16) + "\r\n" + body + "\r\n0\r\n\r\n"
        : "HTTP/1.1 200 OK\r\n" + header + "\r\n" + body;
    push(f, response);
    f.parser.end();
    expect(f.errors).toEqual([]);
    expect(f.chunks.map((bytes) => decoder.decode(bytes)).join("")).toBe(body);
    expect(f.ended).toBe(1);
  });
}

for (const token of [
  "-1",
  "+1",
  "1g",
  "0x1",
  "1 1",
  "0garbage",
  "20000000000000",
  "f".repeat(300),
  "",
]) {
  test(`WAF-003 rejects the entire unsafe or malformed size token ${JSON.stringify(token.slice(0, 24))}`, () => {
    const f = fixture();
    push(f, chunked + token + ";extension=é\r\n");
    failed(f, "bad chunk size");
    expect(f.chunks).toHaveLength(0);
  });
}

for (const terminator of ["XX", "\rX", "X\n"]) {
  for (const split of [false, true]) {
    test(`WAF-003 validates ${JSON.stringify(terminator)} data terminator ${split ? "split" : "together"}`, () => {
      const f = fixture();
      push(f, chunked + "1\r\na");
      push(f, split ? terminator[0]! : terminator);
      if (split) {
        expect(f.errors).toEqual([]);
        push(f, terminator[1]!);
      }
      failed(f, "chunk terminator");
      expect(f.chunks.map((bytes) => decoder.decode(bytes)).join("")).toBe("a");
    });
  }
}

test("WAF-003 preserves zero padding, mixed hex, Unicode trim/extensions and every byte split", () => {
  const body = "abcdefghij";
  const bytes = encoder.encode(
    chunked + "\u2003000a\t;note=日本語\r\n" + body + "\r\n0000\r\nX: é\r\n\r\n",
  );
  for (let split = 0; split <= bytes.length; split++) {
    const f = fixture();
    f.parser.push(bytes.subarray(0, split));
    f.parser.push(bytes.subarray(split));
    f.parser.end();
    expect(f.errors).toEqual([]);
    expect(f.chunks.map((chunk) => decoder.decode(chunk)).join("")).toBe(body);
    expect(f.ended).toBe(1);
  }
});

test("WAF-003 accepts safe maximum size and rejects a truncated split terminator on end", () => {
  const safe = fixture();
  push(safe, chunked + "1fFfFfFfFfFfFf\r\na");
  expect(safe.errors).toEqual([]);
  expect(safe.chunks).toHaveLength(1);
  safe.parser.end();
  failed(safe, "mid-response");
  const truncated = fixture();
  push(truncated, chunked + "1\r\na\r");
  expect(truncated.errors).toEqual([]);
  truncated.parser.end();
  failed(truncated, "mid-response");
});

for (const item of metadataCases.slice(1)) {
  test(`WAF-003 bounds ${item.name} coalesced with a head or preceding chunk body`, () => {
    const f = fixture();
    push(f, item.prefix + item.value);
    failed(f, item.name);
    const afterBody = fixture();
    push(afterBody, chunked + "1\r\n");
    const trailerPrefix = item.name === "trailers" ? "0\r\n" : "";
    push(afterBody, "a\r\n" + trailerPrefix + item.value);
    failed(afterBody, item.name);
    expect(afterBody.chunks.map((bytes) => decoder.decode(bytes)).join("")).toBe("a");
  });
}

test("WAF-003 counts encoded bytes rather than Unicode characters", () => {
  const f = fixture();
  push(f, "HTTP/1.1 200 OK\r\nX: " + "é".repeat(HEAD_LIMIT / 2) + "\r\n\r\n");
  failed(f, "head");
  const line = fixture();
  push(line, chunked + "0;" + "é".repeat(LINE_LIMIT / 2) + "\r\n");
  failed(line, "chunk-size");
  const trailers = fixture();
  push(trailers, chunked + "0\r\nX: " + "é".repeat(TRAILER_LIMIT / 2) + "\r\n\r\n");
  failed(trailers, "trailers");
});

function observedSnapshotSizes(run: () => void): number[] {
  const Native = globalThis.Uint8Array;
  const sizes: number[] = [];
  globalThis.Uint8Array = new Proxy(Native, {
    construct(target, args, newTarget) {
      const source = args[0];
      if (ArrayBuffer.isView(source)) sizes.push(source.byteLength);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    run();
    return sizes;
  } finally {
    globalThis.Uint8Array = Native;
  }
}

for (const kind of bufferKinds.filter((value) => !value.startsWith("fixed"))) {
  for (const framing of ["length", "chunked"]) {
    test(`WAF-003 bounds a ${kind} special-backing snapshot after short ${framing} data`, () => {
      const f = fixture();
      const prefix =
        framing === "length" ? "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx" : chunked + "2\r\nx";
      push(f, prefix);
      const ending = framing === "chunked" ? "\r\n0;" : "";
      const span = callerSpan(encoder.encode("y" + ending + "a".repeat(HEAD_LIMIT * 8)), kind);
      const copies = observedSnapshotSizes(() => f.parser.push(span));
      expect(copies.length).toBeGreaterThan(0);
      expect(Math.max(...copies)).toBeLessThanOrEqual(framing === "length" ? 1 : LINE_LIMIT);
      expect(f.chunks.map((bytes) => decoder.decode(bytes)).join("")).toBe("xy");
      if (framing === "chunked") failed(f, "chunk-size");
      else {
        expect(f.errors).toEqual([]);
        expect(f.ended).toBe(1);
      }
    });
  }
}

for (const kind of ["Uint8Array", "fixed Buffer"]) {
  test(`WAF-003 ${kind} retained-tail compaction drops a large body backing`, () => {
    const body = "a".repeat(512 * 1024);
    const wire = chunked + body.length.toString(16) + "\r\n" + body + "\r\n0;";
    const input = kind === "fixed Buffer" ? Buffer.from(wire) : encoder.encode(wire);
    const errors: string[] = [];
    let delivered = 0;
    const parser = new ResponseParser({
      head() {},
      data(bytes) {
        delivered += bytes.length;
      },
      end() {},
      error(message) {
        errors.push(message);
      },
    });
    try {
      parser.push(input);
      const pending: unknown = Reflect.get(parser, "pending");
      if (!(pending instanceof Uint8Array)) throw new Error("Missing parser byte view");
      expect(errors).toEqual([]);
      expect(delivered).toBe(body.length);
      expect(pending.byteLength).toBe(2);
      expect(pending.buffer.byteLength).toBeLessThanOrEqual(LINE_LIMIT);
      expect(pending.buffer).not.toBe(input.buffer);
    } finally {
      parser.end();
    }
  });
}

test("WAF-003 a complete fixed Buffer retains decoder backing identity", () => {
  const input = Buffer.from("HTTP/1.1 204 No Content\r\n\r\n");
  const f = fixture();
  withStrictDecoder((backings) => {
    f.parser.push(input);
    expect(f.errors).toEqual([]);
    expect(backings).toHaveLength(1);
    expect(backings[0]).toBe(input.buffer);
    expect(f.parser.done).toBe(true);
  });
});
