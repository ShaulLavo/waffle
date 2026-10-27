import assert from "node:assert/strict";
import { test } from "node:test";
import { findOutput } from "../tests/helpers/find-cases.ts";

function nulOutput(records: readonly Uint8Array[], status = "0") {
  const payload = Buffer.concat(
    records.map((record) => Buffer.concat([Buffer.from(record), Buffer.from([0])])),
  );
  return Buffer.concat([Buffer.from(`status:${status}\n`), payload]);
}

function rawOutput(payload: Uint8Array, status = "0") {
  return Buffer.concat([Buffer.from(`status:${status}\n`), Buffer.from(payload)]);
}

function normalized(output: Uint8Array) {
  return findOutput(output, "nul", "status-line");
}

test("find output normalization canonicalizes Buffer and Uint8Array inputs", () => {
  const nul = nulOutput([Buffer.from("sub/b.txt"), Buffer.from("sub/deep/c.txt")]);
  const lines = Buffer.from("sub/b.txt\nsub/deep/c.txt\n");
  const bytes = Buffer.from([0xff, 0x00, 0xfe]);
  assert.deepEqual(normalized(nul), normalized(Uint8Array.from(nul)));
  assert.deepEqual(findOutput(lines, "lines"), findOutput(Uint8Array.from(lines), "lines"));
  assert.deepEqual(findOutput(bytes, "bytes"), findOutput(Uint8Array.from(bytes), "bytes"));
});

test("NUL find records ignore traversal order but preserve the exact status prefix", () => {
  const first = nulOutput([Buffer.from("sub/b.txt"), Buffer.from("sub/deep/c.txt")]);
  const second = nulOutput([Buffer.from("sub/deep/c.txt"), Buffer.from("sub/b.txt")]);
  assert.deepEqual(normalized(first), normalized(second));
});

test("NUL find normalization rejects status, byte, multiplicity, and framing changes", () => {
  const baseline = nulOutput([Buffer.from("b"), Buffer.from("c")]);
  const cases = [
    ["status mutation", nulOutput([Buffer.from("b"), Buffer.from("c")], "1")],
    ["file byte mutation", nulOutput([Buffer.from("b"), Buffer.from("d")])],
    ["duplicate mutation", nulOutput([Buffer.from("b"), Buffer.from("b")])],
    ["missing record mutation", nulOutput([Buffer.from("b")])],
    ["missing final NUL", rawOutput(Buffer.from("b\0c"))],
    ["trailing non-record bytes", rawOutput(Buffer.from("b\0c\n"))],
  ] as const;
  for (const [name, candidate] of cases)
    assert.notDeepEqual(normalized(baseline), normalized(candidate), name);
  assert.notDeepEqual(
    normalized(nulOutput([Uint8Array.of(0xff)])),
    normalized(nulOutput([Uint8Array.of(0xfe)])),
    "malformed byte mutation",
  );
});

test("NUL find normalization keeps duplicate and empty records", () => {
  const duplicate = nulOutput([Buffer.from("b"), Buffer.from("b")]);
  const single = nulOutput([Buffer.from("b")]);
  const empty = nulOutput([Buffer.from("b"), new Uint8Array()]);
  assert.notDeepEqual(normalized(duplicate), normalized(single));
  assert.notDeepEqual(normalized(empty), normalized(single));
});
