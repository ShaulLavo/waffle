import { expect, test } from "bun:test";
import { pack, unpack } from "../fs/protocol";
import { withLateBigintHooks } from "./fixtures/bigint-hooks";

const bytes = (value: string) => new TextEncoder().encode(value);
const records = [
  { $bigint: "42" },
  { $bigint: "42", label: "keep" },
  { $bytes: [1, 2] },
  { $bytes: [1, 2], label: "keep" },
  { $map: [["key", "value"]] },
  { $map: [["key", "value"]], label: "keep" },
  { $undefined: true },
  { $undefined: true, label: "keep" },
  { $record: [["key", "value"]] },
  { $record: [["key", "value"]], label: "keep" },
  { $bigint: "01", $bytes: [256], $undefined: false, $map: null, $record: 7 },
];

for (const record of records) {
  test(`transport preserves literal ${JSON.stringify(record)}`, () => {
    expect(unpack(pack(record))).toEqual(record);
    const nested = {
      record,
      array: [record, 42n, new Uint8Array([0, 128, 255])],
      map: new Map<unknown, unknown>([
        [record, record],
        [42n, record],
      ]),
    };
    expect(unpack(pack(nested))).toEqual(nested);
  });
}

test("escaped records preserve undefined deletion and special property names", () => {
  const record = JSON.parse('{"$bigint":"42","__proto__":{"literal":true}}');
  const decoded = unpack(pack({ ...record, absent: undefined }));
  expect(decoded).toEqual(record);
  expect(Object.hasOwn(decoded, "absent")).toBe(false);
  expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  const array = unpack(pack([undefined, record]));
  expect(array).toHaveLength(2);
  expect(Object.hasOwn(array, 0)).toBe(false);
  expect(array[1]).toEqual(record);
});

test("transport bigint conversions bypass late hooks without losing full-width values", () => {
  const value = { id: (1n << 128n) - 1n, signed: -(1n << 128n), zero: 0n };
  const result = withLateBigintHooks(() => unpack(pack(value)));
  expect(result.value).toEqual(value);
  expect(result.calls).toBe(0);
});

const invalidBytes = [
  "null",
  "true",
  "false",
  '"7"',
  '""',
  "{}",
  "[]",
  "-1",
  "256",
  "1.5",
  "1e309",
  '{"$undefined":true}',
  '{"$bigint":"7"}',
  '{"$bytes":[7]}',
  '{"$map":[]}',
];
for (const invalid of invalidBytes) {
  for (const position of [0, 1, 2]) {
    test(`nested bytes reject ${invalid} at position ${position}`, () => {
      const values = ["7", "8", "9"];
      values[position] = invalid;
      const raw = `{"nested":{"$bytes":[${values.join(",")}]}}`;
      expect(() => unpack(bytes(raw))).toThrow();
    });
  }
}

for (const payload of ["null", "{}", '"7"', "true", "[7,,9]", "[,8,9]", "[7,8,]"]) {
  test(`nested bytes reject missing or non-array payload ${payload}`, () => {
    expect(() => unpack(bytes(`{"nested":{"$bytes":${payload}}}`))).toThrow();
  });
}


test("nested bytes reject an undefined payload before tag revival can erase it", () => {
  expect(() => unpack(bytes('{"nested":{"$bytes":{"$undefined":true}}}'))).toThrow();
});
