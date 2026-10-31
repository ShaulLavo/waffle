import { expect, test } from "bun:test";
import { addStartSection } from "./fixtures/wasm-start-section.ts";

function fixture(start: boolean): Uint8Array<ArrayBuffer> {
  const text = (value: string) => {
    const bytes = Array.from(new TextEncoder().encode(value));
    return [bytes.length].concat(bytes);
  };
  const section = (id: number, data: number[]) => [id, data.length].concat(data);
  // Imported mark(i32), plus two original () -> () functions that mark 1 and 2.
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [2, 96, 0, 0, 96, 1, 127, 0]),
      section(2, [1].concat(text("fixture"), text("mark"), [0, 1])),
      section(3, [2, 0, 0]),
      section(7, [1].concat(text("early_preopens"), [0, 2])),
      start ? section(8, [1]) : [],
      section(10, [2, 6, 0, 65, 1, 16, 0, 11, 6, 0, 65, 2, 16, 0, 11]),
    ),
  );
}
for (const start of [false, true])
  test(`start-section fixture preserves an existing initializer (existing=${start})`, () => {
    const observed: number[] = [];
    new WebAssembly.Instance(
      new WebAssembly.Module(addStartSection(fixture(start), "early_preopens")),
      {
        fixture: {
          mark(value: number) {
            observed.push(value);
          },
        },
      },
    );
    expect(observed).toEqual(start ? [1, 2] : [2]);
  });
test("start-section fixture rejects a missing exported entry point", () => {
  expect(() => addStartSection(fixture(true), "missing")).toThrow("missing start export");
});
