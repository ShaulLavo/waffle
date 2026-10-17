import { expect, test } from "bun:test";
import { bufferKinds, callerSpan, withStrictDecoder } from "../../runtime/tests/fixtures/buffer-boundaries";
import { ResponseParser, type ResponseHead } from "../src/net/http1";

const encode = (text: string) => new TextEncoder().encode(text);
function fixture() {
  const out = { head: null as ResponseHead | null, body: [] as number[], ended: 0, errors: [] as string[] };
  const parser = new ResponseParser({
    head: head => { out.head = head; },
    data: bytes => { out.body = out.body.concat(Array.from(bytes)); },
    end: () => { out.ended++; },
    error: message => { out.errors.push(message); },
  });
  return { parser, out };
}

for (const kind of bufferKinds) {
  test(`response parser decodes a full header from a selected ${kind} buffer span`, () => {
    const { parser, out } = fixture();
    const span = callerSpan(encode("HTTP/1.1 201 Créé\r\nX-Name: 日本語\r\nContent-Length: 6\r\n\r\né🌍"), kind);
    withStrictDecoder(backings => {
      parser.push(span);
      expect(out.errors).toEqual([]);
      expect(out.head).toEqual({ status: 201, statusText: "Créé", headers: [["x-name", "日本語"], ["content-length", "6"]] });
      expect(out.body).toEqual(Array.from(encode("é🌍")));
      expect(out.ended).toBe(1);
      expect(parser.done).toBe(true);
      expect(backings).toHaveLength(1);
      if (kind.startsWith("fixed")) expect(backings[0]).toBe(span.buffer);
      else expect(backings[0]).not.toBe(span.buffer);
    });
  });

  test(`response parser owns partial ${kind} chunks across status, headers, body and trailers`, () => {
    const { parser, out } = fixture();
    const push = (text: string) => {
      const span = callerSpan(encode(text), kind);
      parser.push(span);
      // Special backings must not survive push: callers can overwrite or resize them.
      if (!kind.startsWith("fixed")) span.fill(0xff);
      expect(out.errors).toEqual([]);
    };
    withStrictDecoder(backings => {
      push("HTTP/1.1 20");
      expect(out.head).toBeNull();
      expect(parser.done).toBe(false);
      push("1 Créé\r\nX-Name: 日");
      expect(out.head).toBeNull();
      push("本語\r\nTransfer-Encoding: chunked\r\n\r\n");
      expect(out.head).toEqual({ status: 201, statusText: "Créé", headers: [["x-name", "日本語"], ["transfer-encoding", "chunked"]] });
      expect(out.body).toEqual([]);
      push("6;note=é\r\n"); // Empty pending: exercise the chunk-size decoder directly.
      push("é");
      expect(out.body).toEqual(Array.from(encode("é")));
      expect(out.ended).toBe(0);
      push("🌍\r");
      expect(out.body).toEqual(Array.from(encode("é🌍")));
      push("\n");
      push("0\r\nX-Trailer: 日");
      expect(parser.done).toBe(false);
      push("本語\r\n\r");
      expect(out.ended).toBe(0);
      push("\n");
      expect(parser.done).toBe(true);
      expect(out.ended).toBe(1);
      expect(out.body).toEqual(Array.from(encode("é🌍")));
      expect(backings).toHaveLength(3); // Response head and two chunk sizes.
    });
    parser.end();
    expect(out.ended).toBe(1);
  });
}
