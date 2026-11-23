import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { stageProgram } from "./program-build-tools.ts";
import { programBytesIdentity, validateProgramDerivation } from "./program-derivation.ts";
import { definitionNames, programSymbolsReference } from "./program-symbols.ts";
import { cappedWasiFixture } from "../packages/python/scripts/wasi-artifact-fixture.ts";
import {
  exportedFunctions,
  functionNameMap,
  nameSection,
  namedWasiFixture,
  text,
  u32,
  wasiModule,
} from "./program-symbols-fixture.ts";

function fixture(
  run: (receipt: ReturnType<typeof stageProgram>, bytes: Buffer, producer: Buffer) => void,
) {
  const parent =
    process.env.PROGRAM_OPTIMIZER_TEST_ROOT ?? resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "derivation-test-"));
  try {
    const source = resolve(directory, "input.wasm");
    const output = resolve(directory, "python.wasm");
    writeFileSync(source, cappedWasiFixture);
    const producer = Buffer.from(
      JSON.stringify({
        assets: { "python.wasm": programBytesIdentity(cappedWasiFixture).sha256 },
        interpreterBytes: cappedWasiFixture.length,
      }),
    );
    const producerPath = resolve(directory, "python-build.json");
    writeFileSync(producerPath, producer);
    const receipt = stageProgram(source, output, {}, producerPath);
    run(receipt, readFileSync(output), producer);
    assert.deepEqual(readFileSync(producerPath), producer, "Original producer stays immutable");
    assert.deepEqual(readFileSync(source), Buffer.from(cappedWasiFixture));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("strict Python derivation binds producer, optimizer, strip and actual final bytes", () => {
  fixture((receipt, bytes, producer) => {
    validateProgramDerivation(receipt, bytes, producer);
    assert.throws(() => validateProgramDerivation({}, bytes, producer));
    assert.throws(() => validateProgramDerivation(receipt, Uint8Array.of(0), producer));
    assert.throws(() => validateProgramDerivation(receipt, bytes));
    assert.throws(() => validateProgramDerivation(receipt, bytes, Buffer.from("{}")));
  });
});

test("transformer commit is provenance, while actual transformation hashes govern currentness", () => {
  fixture((receipt, bytes, producer) => {
    receipt.transformer.commit = "a".repeat(40);
    validateProgramDerivation(receipt, bytes, producer);
    receipt.transformer.optimizerSourceSha256 = "b".repeat(64);
    assert.throws(
      () => validateProgramDerivation(receipt, bytes, producer),
      /Optimizer source changed/,
    );
  });
});

const corruptions: readonly [string, (value: Record<string, unknown>) => void][] = [
  [
    "wrong operation",
    (value) => {
      value.operation = "strip-wasm-name-sections";
    },
  ],
  [
    "missing chain",
    (value) => {
      value.operations = [];
    },
  ],
  [
    "stale final",
    (value) => {
      value.output = { bytes: 8, sha256: "0".repeat(64) };
    },
  ],
  [
    "nonfinite size",
    (value) => {
      value.input = { bytes: Infinity, sha256: "0".repeat(64) };
    },
  ],
  [
    "oversized size",
    (value) => {
      value.input = { bytes: 2 ** 32, sha256: "0".repeat(64) };
    },
  ],
  [
    "fractional size",
    (value) => {
      value.input = { bytes: 8.5, sha256: "0".repeat(64) };
    },
  ],
  [
    "invalid hash",
    (value) => {
      value.input = { bytes: 8, sha256: "xyz" };
    },
  ],
  [
    "stale producer",
    (value) => {
      value.producerReceiptSha256 = "0".repeat(64);
    },
  ],
];
for (const [description, corrupt] of corruptions) {
  test(`derivation rejects ${description}`, () => {
    fixture((receipt, bytes, producer) => {
      const changed: Record<string, unknown> = JSON.parse(JSON.stringify(receipt));
      corrupt(changed);
      assert.throws(() => validateProgramDerivation(changed, bytes, producer));
    });
  });
}

test("every optimizer policy and chain field is checked, not just nonempty receipt JSON", () => {
  fixture((receipt, bytes, producer) => {
    for (const field of ["policy", "version", "sha256", "flags", "environment"]) {
      const optimized = receipt.operations[0];
      assert.ok(optimized && "optimizer" in optimized);
      const changed = {
        ...receipt,
        operations: [
          { ...optimized, optimizer: { ...optimized.optimizer, [field]: null } },
          receipt.operations[1],
        ],
      };
      assert.throws(() => validateProgramDerivation(changed, bytes, producer));
    }
    const strip = receipt.operations[1];
    assert.ok(strip);
    assert.throws(() =>
      validateProgramDerivation(
        { ...receipt, operations: [receipt.operations[0], { ...strip, input: receipt.output }] },
        bytes,
        producer,
      ),
    );
    const wrongSize = Buffer.from(
      JSON.stringify({
        assets: { "python.wasm": receipt.input.sha256 },
        interpreterBytes: receipt.input.bytes + 1,
      }),
    );
    const optimized = receipt.operations[0];
    assert.ok(optimized);
    const changed = {
      ...receipt,
      producerReceiptSha256: programBytesIdentity(wrongSize).sha256,
      operations: [{ ...optimized, producerReceipt: programBytesIdentity(wrongSize) }, strip],
    };
    assert.throws(
      () => validateProgramDerivation(changed, bytes, wrongSize),
      /Original Python interpreter size/,
    );
  });
});

test("one stage operation publishes deterministic final outputs to multiple destinations", () => {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "stage-twins-"));
  try {
    const source = resolve(directory, "source.wasm");
    writeFileSync(source, cappedWasiFixture);
    const first = resolve(directory, "first.wasm");
    const second = resolve(directory, "second.wasm");
    for (const path of [first, second]) {
      writeFileSync(`${path}.gz`, "stale gzip");
      writeFileSync(`${path}.br`, "stale Brotli");
    }
    const receipt = stageProgram(source, [first, second]);
    const readOutputs = (path: string) => ({
      bytes: readFileSync(path),
      gzip: readFileSync(`${path}.gz`),
      brotli: readFileSync(`${path}.br`),
      receipt: readFileSync(path.replace(/\.wasm$/, "-program.json")),
    });
    const firstOutputs = readOutputs(first);
    assert.deepEqual(readOutputs(second), firstOutputs);
    assert.ok(gunzipSync(firstOutputs.gzip).equals(firstOutputs.bytes));
    assert.ok(brotliDecompressSync(firstOutputs.brotli).equals(firstOutputs.bytes));
    validateProgramDerivation(receipt, firstOutputs.bytes);
    stageProgram(source, [first, second]);
    assert.deepEqual(readOutputs(first), firstOutputs, "repeat staging is deterministic");
    assert.deepEqual(readOutputs(second), firstOutputs, "repeat twin staging is deterministic");
    assert.throws(() => stageProgram(source, source), /must differ|aliases compiler input/);
    assert.deepEqual(readFileSync(source), Buffer.from(cappedWasiFixture));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the old policy and flags cannot be relabeled as a current derivative", () => {
  fixture((receipt, bytes, producer) => {
    const optimization = receipt.operations[0];
    assert.ok(optimization && "optimizer" in optimization);
    assert.equal(optimization.optimizer.policy, "waffle-program-size-v2");
    assert.ok(optimization.optimizer.flags.includes("--enable-exception-handling"));
    const oldOptimizer = {
      ...optimization.optimizer,
      policy: "waffle-program-size-v1",
      flags: optimization.optimizer.flags.filter((flag) => flag !== "--enable-exception-handling"),
    };
    const old = {
      ...receipt,
      operations: [{ ...optimization, optimizer: oldOptimizer }, receipt.operations[1]],
    };
    assert.throws(
      () => validateProgramDerivation(old, bytes, producer),
      /Unpinned optimizer policy/,
    );
    const oldSource = {
      ...receipt,
      transformer: {
        ...receipt.transformer,
        optimizerSourceSha256: "4d7c275c57aee3d6c782f2d15f8bda138756a0ec334f7e394d7e960cb896c79b",
      },
    };
    assert.throws(
      () => validateProgramDerivation(oldSource, bytes, producer),
      /Optimizer source changed/,
    );
  });
});

const symbolNames = ["_start", "outer", "inner_trap"];

function symbolFixture(run: (directory: string, source: string) => void) {
  const parent =
    process.env.PROGRAM_OPTIMIZER_TEST_ROOT ?? resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "symbols-test-"));
  try {
    const source = resolve(directory, "input.wasm");
    writeFileSync(source, namedWasiFixture(symbolNames));
    run(directory, source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const symbolPaths = (wasm: string) =>
  [".json", ".ts"].map((suffix) => wasm.replace(/\.wasm$/, `-symbols${suffix}`));

test("opt-in staging binds a name sidecar without changing the stripped program", () => {
  symbolFixture((directory, source) => {
    const plain = resolve(directory, "plain/echo.wasm");
    const opted = resolve(directory, "opted/echo.wasm");
    for (const path of [plain, opted]) mkdirSync(resolve(path, ".."));
    const without = stageProgram(source, plain);
    const receipt = stageProgram(source, opted, {}, undefined, { emitSymbols: true });
    for (const suffix of ["", ".gz", ".br"])
      assert.deepEqual(readFileSync(opted + suffix), readFileSync(plain + suffix), suffix);
    assert.equal("symbols" in without, false, "programs that do not opt in are unchanged");
    for (const path of symbolPaths(plain)) assert.equal(existsSync(path), false);
    const { symbols, ...unchanged } = receipt;
    assert.deepEqual(unchanged, without);
    assert.ok(symbols);
    const bytes = readFileSync(opted);
    const [sidecarPath, referencePath] = symbolPaths(opted);
    const sidecar = readFileSync(sidecarPath!);
    validateProgramDerivation(receipt, bytes, undefined, sidecar);
    assert.deepEqual(symbols.input, receipt.operations[0]?.output);
    assert.deepEqual(symbols.output, programBytesIdentity(sidecar));
    const parsed = JSON.parse(sidecar.toString());
    assert.deepEqual(Object.keys(parsed), [
      "version",
      "source",
      "named",
      "importedFunctions",
      "names",
    ]);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.source, programBytesIdentity(bytes));
    assert.deepEqual(parsed.named, symbols.input);
    assert.equal(parsed.importedFunctions, 1);
    assert.equal(parsed.names.length, symbolNames.length);
    const exported = exportedFunctions(bytes);
    assert.equal(exported.size, symbolNames.length);
    for (const [name, index] of exported)
      assert.equal(parsed.names[index - 1], symbolNames[Number(name.slice(1))], name);
    assert.equal(
      readFileSync(referencePath!, "utf8"),
      programSymbolsReference("echo", symbols.output),
    );
    stageProgram(source, opted);
    for (const path of symbolPaths(opted))
      assert.equal(existsSync(path), false, "a program that stops opting in leaves no sidecar");
  });
});

test("derivation rejects missing, undeclared, altered and mismatched sidecars", () => {
  symbolFixture((directory, source) => {
    const output = resolve(directory, "echo.wasm");
    const receipt = stageProgram(source, output, {}, undefined, { emitSymbols: true });
    const { symbols, ...undeclared } = receipt;
    assert.ok(symbols);
    const bytes = readFileSync(output);
    const sidecar = readFileSync(symbolPaths(output)[0]!);
    const check = (value: unknown, encoded: Uint8Array | undefined, pattern: RegExp) =>
      assert.throws(() => validateProgramDerivation(value, bytes, undefined, encoded), pattern);
    check(receipt, undefined, /Missing declared program symbols/);
    check(undeclared, sidecar, /not declared by the derivation/);
    check(receipt, Buffer.from(sidecar.toString().replace('"outer"', '"other"')), /identity/);
    const parsed = JSON.parse(sidecar.toString());
    const content: readonly [string, unknown, RegExp][] = [
      [
        "wrong source hash",
        { ...parsed, source: { ...parsed.source, sha256: "0".repeat(64) } },
        /source identity/,
      ],
      ["missing name", { ...parsed, names: parsed.names.slice(1) }, /definition count/],
      ["extra name", { ...parsed, names: parsed.names.concat(["extra"]) }, /definition count/],
      ["import count", { ...parsed, importedFunctions: 0 }, /import count/],
      ["named identity", { ...parsed, named: parsed.source }, /named identity/],
      ["empty name", { ...parsed, names: parsed.names.map(() => "") }, /Invalid program symbols/],
      ["version", { ...parsed, version: 2 }, /version/],
      ["indented", JSON.stringify(parsed, null, 2), /canonically/],
      ["reordered", JSON.stringify({ names: parsed.names, ...parsed }), /canonically/],
      ["invalid JSON", "{", /JSON/],
    ];
    for (const [description, value, pattern] of content) {
      const encoded = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      const rebound = {
        ...receipt,
        symbols: { ...symbols, output: programBytesIdentity(encoded) },
      };
      assert.throws(
        () => validateProgramDerivation(rebound, bytes, undefined, encoded),
        pattern,
        description,
      );
    }
    const declarations: readonly [string, unknown, RegExp][] = [
      ["operation", { ...symbols, operation: "strip-wasm-name-sections" }, /operation/],
      ["extractor", { ...symbols, extractorSha256: "0".repeat(64) }, /extractor changed/],
      [
        "input",
        { ...symbols, input: { ...symbols.input, sha256: "0".repeat(64) } },
        /input differs/,
      ],
      ["field", { ...symbols, extra: true }, /fields/],
      ["output", { ...symbols, output: { ...symbols.output, bytes: 0 } }, /size/],
    ];
    for (const [description, value, pattern] of declarations)
      assert.throws(
        () => validateProgramDerivation({ ...receipt, symbols: value }, bytes, undefined, sidecar),
        pattern,
        description,
      );
  });
});

test("the name reader keeps duplicates by definition index and rejects malformed maps", () => {
  assert.deepEqual(definitionNames(namedWasiFixture(["same", "same", "x"])), {
    importedFunctions: 1,
    names: ["same", "same", "x"],
  });
  const sparse = nameSection([
    [0, text("module")],
    [
      1,
      functionNameMap([
        [0, "proc_exit"],
        [2, "second"],
      ]),
    ],
    [2, [0]],
  ]);
  assert.deepEqual(definitionNames(wasiModule(3, sparse)).names, [null, "second", null]);
  assert.deepEqual(definitionNames(wasiModule(0)), { importedFunctions: 1, names: [] });
  const map = (entries: readonly (readonly [number, string | Uint8Array])[]) =>
    wasiModule(2, nameSection([[1, functionNameMap(entries)]]));
  const one = functionNameMap([[1, "a"]]);
  const malformed: readonly [string, Uint8Array, RegExp][] = [
    [
      "descending",
      map([
        [2, "b"],
        [1, "a"],
      ]),
      /ascending/,
    ],
    [
      "repeated index",
      map([
        [1, "a"],
        [1, "b"],
      ]),
      /ascending/,
    ],
    ["out of range", map([[3, "c"]]), /out of range/],
    ["invalid UTF-8", map([[1, Uint8Array.of(0xff)]]), /./],
    ["trailing bytes", wasiModule(2, nameSection([[1, one.concat([0])]])), /Trailing/],
    ["truncated", wasiModule(2, nameSection([[1, u32(1)]])), /Truncated/],
    [
      "repeated subsection",
      wasiModule(
        2,
        nameSection([
          [1, one],
          [1, one],
        ]),
      ),
      /out of order/,
    ],
    [
      "subsection order",
      wasiModule(
        2,
        nameSection([
          [1, one],
          [0, text("m")],
        ]),
      ),
      /out of order/,
    ],
    ["two sections", wasiModule(2, nameSection([[1, one]]).concat(nameSection([]))), /exactly one/],
    ["no section", wasiModule(2), /exactly one/],
    ["import names only", map([[0, "proc_exit"]]), /no function definition names/],
  ];
  for (const [description, bytes, pattern] of malformed)
    assert.throws(() => definitionNames(bytes), pattern, description);
});
