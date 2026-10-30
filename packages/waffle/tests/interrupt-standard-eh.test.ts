import { expect, test } from "bun:test";
import { rewriteInterrupts } from "../interrupt/rewriter.ts";

// Exact retained eh-control.wasm, SHA-256 60ceb7a0b6045b65085a5ec52917491c2878e04a5677abec247ef218af9c37e1.
const control = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x09, 0x02, 0x60, 0x01, 0x7f, 0x00, 0x60,
  0x00, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x01, 0x0d, 0x03, 0x01, 0x00, 0x00, 0x07, 0x07, 0x01, 0x03,
  0x72, 0x75, 0x6e, 0x00, 0x00, 0x0a, 0x14, 0x01, 0x12, 0x00, 0x02, 0x7f, 0x1f, 0x40, 0x01, 0x00,
  0x00, 0x00, 0x41, 0x07, 0x08, 0x00, 0x0b, 0x41, 0x00, 0x0b, 0x0b, 0x00, 0x1b, 0x04, 0x6e, 0x61,
  0x6d, 0x65, 0x03, 0x0b, 0x01, 0x00, 0x01, 0x00, 0x06, 0x63, 0x61, 0x75, 0x67, 0x68, 0x74, 0x0b,
  0x07, 0x01, 0x00, 0x04, 0x65, 0x78, 0x69, 0x74,
]);

function run(bytes: Uint8Array<ArrayBuffer>): unknown {
  const guest = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    runtime_proc: { __waffle_fatal: () => 0 },
  });
  const entry = guest.exports.run;
  if (typeof entry !== "function") throw new Error("Missing run export");
  return entry();
}

test("the retained standard tag/try_table/throw control preserves its native result", () => {
  expect(new Bun.CryptoHasher("sha256").update(control).digest("hex")).toBe(
    "60ceb7a0b6045b65085a5ec52917491c2878e04a5677abec247ef218af9c37e1",
  );
  expect(run(control)).toBe(7);
  expect(run(rewriteInterrupts(control))).toBe(7);
});

const leb = (value: number): number[] =>
  value < 128 ? [value] : [128 | (value & 127)].concat(leb(Math.floor(value / 128)));
const segment = (id: number, payload: number[]) => [id].concat(leb(payload.length), payload);
const vector = (items: number[][]) => leb(items.length).concat(...items);
const text = (value: string) => {
  const bytes = Array.from(new TextEncoder().encode(value));
  return leb(bytes.length).concat(bytes);
};
const signature = (params: number[], results: number[]) =>
  [0x60].concat(leb(params.length), params, leb(results.length), results);
const signatures = (...items: number[][]) => segment(1, vector(items));
const functions = (...indices: number[]) => segment(3, vector(indices.map(leb)));
const tags = (...indices: number[]) =>
  segment(13, vector(indices.map((index) => [0].concat(leb(index)))));
const exported = (label: string, kind: number, index: number) =>
  text(label).concat([kind], leb(index));
const exportedItems = (...items: number[][]) => segment(7, vector(items));
const bodies = (...items: number[][]) =>
  segment(10, vector(items.map((item) => leb(item.length + 1).concat([0], item))));
const moduleBytes = (...items: number[][]) =>
  new Uint8Array(Array.from(control.subarray(0, 8)).concat(...items));
const importEntry = (label: string, kind: number, descriptor: number[]) =>
  text("env").concat(text(label), [kind], descriptor);

function instantiate(
  bytes: Uint8Array<ArrayBuffer>,
  fatal: () => number = () => 0,
  env: WebAssembly.ModuleImports = {},
): WebAssembly.Instance {
  expect(WebAssembly.validate(bytes)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env,
    runtime_proc: { __waffle_fatal: fatal },
  });
}

function invoke(guest: WebAssembly.Instance, name = "run"): unknown {
  const fn = guest.exports[name];
  if (typeof fn !== "function") throw new Error(`Missing ${name} export`);
  return fn();
}

function taggedBody(body: number[]): Uint8Array<ArrayBuffer> {
  return moduleBytes(
    signatures(signature([], [])),
    functions(0),
    tags(0),
    exportedItems(exported("run", 0, 0)),
    bodies(body),
  );
}

test("tag imports and exports keep their own indices while defined calls shift", () => {
  const provider = instantiate(
    moduleBytes(signatures(signature([0x7f], [])), tags(0), exportedItems(exported("tag", 4, 0))),
  );
  const bytes = moduleBytes(
    signatures(signature([0x7f], []), signature([], [0x7f])),
    segment(2, vector([importEntry("tag", 4, [0, 0]), importEntry("value", 0, [1])])),
    functions(1, 1),
    tags(0),
    exportedItems(exported("run", 0, 2), exported("imported", 4, 0), exported("defined", 4, 1)),
    bodies(
      [0x02, 0x7f, 0x1f, 0x40, 1, 0, 1, 0, 0x10, 0, 0x08, 1, 0x0b, 0x41, 0, 0x0b, 0x0b],
      [0x02, 0x7f, 0x1f, 0x40, 1, 0, 0, 0, 0x10, 1, 0x08, 0, 0x0b, 0x41, 0, 0x0b, 0x0b],
    ),
  );
  const env = { tag: provider.exports.tag!, value: () => 21 };
  const native = instantiate(bytes, undefined, env);
  const rewritten = instantiate(rewriteInterrupts(bytes, { interval: 1 }), undefined, env);
  expect(invoke(native)).toBe(21);
  expect(invoke(rewritten)).toBe(21);
  expect(rewritten.exports.imported).toBe(provider.exports.tag);
  expect(rewritten.exports.defined).not.toBe(provider.exports.tag);
});

test("all catch forms preserve nested targets, payloads and rethrown exceptions", () => {
  const nested = moduleBytes(
    signatures(signature([0x7f], []), signature([], [0x7f]), signature([], [0x7f, 0x69])),
    functions(1),
    tags(0),
    exportedItems(exported("run", 0, 0)),
    bodies([
      0x02, 0x7f, 0x1f, 0x40, 1, 0, 0, 0, 0x02, 0x69, 0x1f, 0x40, 1, 3, 0, 0x02, 2, 0x1f, 0x40, 1,
      1, 0, 0, 0x41, 7, 0x08, 0, 0x0b, 0x00, 0x0b, 0x0a, 0x0b, 0x00, 0x0b, 0x0a, 0x0b, 0x00, 0x0b,
      0x0b,
    ]),
  );
  expect(invoke(instantiate(nested))).toBe(7);
  expect(invoke(instantiate(rewriteInterrupts(nested, { interval: 1 })))).toBe(7);
});

test("try_table catches can branch to the implicit function label", () => {
  const bytes = taggedBody([0x1f, 0x40, 1, 2, 0, 0x08, 0, 0x0b, 0x00, 0x0b]);
  expect(invoke(instantiate(bytes))).toBeUndefined();
  expect(invoke(instantiate(rewriteInterrupts(bytes)))).toBeUndefined();
});

test("uncaught throw and throw_ref preserve exception identity", () => {
  const bytes = moduleBytes(
    signatures(signature([], [])),
    segment(2, vector([importEntry("raise", 0, [0])])),
    functions(0),
    exportedItems(exported("run", 0, 1)),
    bodies([0x02, 0x69, 0x1f, 0x40, 1, 3, 0, 0x10, 0, 0x0b, 0x00, 0x0b, 0x0a, 0x0b]),
  );
  const exception = new Error("guest cleanup must preserve the original exception");
  const env = {
    raise() {
      throw exception;
    },
  };
  for (const input of [bytes, rewriteInterrupts(bytes)]) {
    expect(() => invoke(instantiate(input, undefined, env))).toThrow(exception);
  }
  const uncaught = taggedBody([0x08, 0, 0x0b]);
  expect(() => invoke(instantiate(uncaught))).toThrow();
  expect(() => invoke(instantiate(rewriteInterrupts(uncaught)))).toThrow();
});

test("guest catch loops cannot swallow cancellation traps", () => {
  for (const catchKind of [2, 3]) {
    const bytes = moduleBytes(
      signatures(signature([], [])),
      segment(2, vector([importEntry("raise", 0, [0])])),
      functions(0),
      exportedItems(exported("run", 0, 1)),
      bodies(
        [
          0x03,
          0x40,
          0x02,
          catchKind === 3 ? 0x69 : 0x40,
          0x1f,
          0x40,
          1,
          catchKind,
          0,
          0x03,
          0x40,
          0x10,
          0,
          0x0c,
          0,
          0x0b,
          0x0b,
          0x00,
          0x0b,
        ].concat(catchKind === 3 ? [0x1a] : [], [0x0c, 0, 0x0b, 0x0b]),
      ),
    );
    let caught = 0;
    let checks = 0;
    const guest = instantiate(
      rewriteInterrupts(bytes, { interval: 3 }),
      () => (++checks >= 3 ? 15 : 0),
      {
        raise() {
          caught++;
          throw new Error("catch me");
        },
      },
    );
    expect(() => invoke(guest)).toThrow(WebAssembly.RuntimeError);
    expect(checks).toBe(3);
    expect(caught).toBe(3);
  }
});

test("EH regions preserve countdown placement and reject null throw_ref with a trap", () => {
  const bytes = taggedBody([0x1f, 0x40, 0, 0x03, 0x40, 0x0c, 0, 0x0b, 0x0b, 0x0b]);
  let checks = 0;
  const guest = instantiate(rewriteInterrupts(bytes, { interval: 3 }), () =>
    ++checks === 2 ? 2 : 0,
  );
  expect(() => invoke(guest)).toThrow(WebAssembly.RuntimeError);
  expect(checks).toBe(2);
  const nullThrow = taggedBody([0xd0, 0x69, 0x0a, 0x0b]);
  expect(() => invoke(instantiate(rewriteInterrupts(nullThrow)))).toThrow(WebAssembly.RuntimeError);
});

test("malformed tag types, indices, section order and catch operands remain rejected", () => {
  const declarations = signatures(signature([], []), signature([], [0x7f]));
  const malformed = [
    moduleBytes(declarations, segment(13, [1, 1, 0])),
    moduleBytes(declarations, tags(1)),
    moduleBytes(declarations, tags(2)),
    moduleBytes(declarations, segment(2, vector([importEntry("tag", 4, [1, 0])]))),
    moduleBytes(declarations, segment(2, vector([importEntry("tag", 4, [0, 1])]))),
    moduleBytes(declarations, tags(0), tags(0)),
    moduleBytes(declarations, exportedItems(exported("tag", 4, 0)), tags(0)),
    moduleBytes(declarations, tags(0), exportedItems(exported("tag", 4, 1))),
    taggedBody([0x08, 1, 0x0b]),
    taggedBody([0x1f, 0x40, 1, 0, 1, 0, 0x0b, 0x0b]),
    taggedBody([0x1f, 0x40, 1, 2, 1, 0x0b, 0x0b]),
    taggedBody([0x1f, 0x40, 1, 4, 0, 0x0b, 0x0b]),
    taggedBody([0x1f, 0x40, 1, 0, 0x80]),
    taggedBody([0x1f, 0x40, 1, 2, 0x80]),
    taggedBody([0x1f, 0x40, 0, 0x0b]),
    taggedBody([0x1f, 0x40, 1, 1, 0, 0, 0x0b, 0x0b]),
  ];
  for (const input of malformed)
    expect(() => rewriteInterrupts(input)).toThrow(WebAssembly.CompileError);
});

test("legacy exception regions and unsupported reference heaps still fail closed", () => {
  const unsupported = [
    taggedBody([0x06, 0x40, 0x19, 0x0b, 0x0b]),
    taggedBody([0x06, 0x40, 0x07, 0, 0x09, 0, 0x0b, 0x0b]),
    taggedBody([0x06, 0x40, 0x18, 0, 0x0b]),
    taggedBody([0xd0, 0x74, 0x1a, 0x0b]),
  ];
  for (const input of unsupported)
    expect(() => rewriteInterrupts(input)).toThrow(WebAssembly.CompileError);
});

test("multi-byte tag indices and catch lists do not enter the shifted function space", () => {
  const tagCount = 130;
  const bytes = moduleBytes(
    signatures(signature([0x7f], []), signature([], [0x7f])),
    functions(1),
    tags(...Array.from({ length: tagCount }, () => 0)),
    exportedItems(exported("run", 0, 0), exported("last", 4, 129)),
    bodies([
      0x02, 0x7f, 0x1f, 0x40, 3, 0, 0, 0, 0, 0x81, 1, 0, 0, 0x80, 1, 0, 0x41, 42, 0x08, 0x81, 1,
      0x0b, 0x41, 0, 0x0b, 0x0b,
    ]),
  );
  expect(invoke(instantiate(bytes))).toBe(42);
  expect(invoke(instantiate(rewriteInterrupts(bytes)))).toBe(42);
});

test("exnref globals, locals, typed select and padded null heap types decode exactly", () => {
  const body = [
    1, 1, 0x69, 0x23, 0, 0xd0, 0x69, 0x41, 1, 0x1c, 1, 0x69, 0x21, 0, 0x20, 0, 0x24, 0, 0x0b,
  ];
  const bytes = moduleBytes(
    signatures(signature([], [])),
    functions(0),
    segment(6, [1, 0x69, 1, 0xd0, 0xe9, 0x7f, 0x0b]),
    exportedItems(exported("run", 0, 0)),
    segment(10, vector([leb(body.length).concat(body)])),
  );
  expect(invoke(instantiate(bytes))).toBeUndefined();
  expect(invoke(instantiate(rewriteInterrupts(bytes)))).toBeUndefined();
});

test("normal module-cache admission instruments EH and shares equal source bytes", async () => {
  const { InterruptModuleCache } = await import("../interrupt/loader.ts");
  const cache = new InterruptModuleCache();
  const [first, second] = await Promise.all([
    cache.compile(control),
    cache.compile(control.slice()),
  ]);
  expect(second).toBe(first);
  const guest = new WebAssembly.Instance(first, { runtime_proc: { __waffle_fatal: () => 0 } });
  expect(invoke(guest)).toBe(7);
  const cancelled = new WebAssembly.Instance(first, { runtime_proc: { __waffle_fatal: () => 2 } });
  // Production admission uses a countdown, so repeated calls eventually reach its first check.
  expect(() => {
    for (let call = 0; call < 4096; call++) invoke(cancelled);
  }).toThrow(WebAssembly.RuntimeError);
});
