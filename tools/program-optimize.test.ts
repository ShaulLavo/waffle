import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { verifyWasiGuest } from "./program-build-tools.ts";
import {
  optimizeProgram,
  programOptimizationCoverage,
  programCOptimizationFlags,
  programOptimizationFlags,
  programOptimizer,
  programReleaseEnvironment,
  type OptimizerOptions,
} from "./program-optimize.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const integer = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const text = (value: string) =>
  integer(value.length).concat(Array.from(new TextEncoder().encode(value)));
const section = (kind: number, bytes: number[]) => [kind].concat(integer(bytes.length), bytes);
const signatures = (...items: number[][]) => section(1, [items.length].concat(...items));
const signature = (params: number[], results: number[]) => [0x60].concat(params.length, params, results.length, results);
const custom = (name: string, bytes: number[]) => section(0, text(name).concat(bytes));
const standardEhControl = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x09, 0x02, 0x60, 0x01, 0x7f, 0x00,
  0x60, 0x00, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x01, 0x0d, 0x03, 0x01, 0x00, 0x00, 0x07,
  0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00, 0x0a, 0x14, 0x01, 0x12, 0x00, 0x02,
  0x7f, 0x1f, 0x40, 0x01, 0x00, 0x00, 0x00, 0x41, 0x07, 0x08, 0x00, 0x0b, 0x41, 0x00,
  0x0b, 0x0b, 0x00, 0x1b, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x03, 0x0b, 0x01, 0x00, 0x01,
  0x00, 0x06, 0x63, 0x61, 0x75, 0x67, 0x68, 0x74, 0x0b, 0x07, 0x01, 0x00, 0x04, 0x65,
  0x78, 0x69, 0x74,
]);
const standardEhFeatures = custom("target_features", [1, 0x2b].concat(text("exception-handling")));
const withStandardEhFeatures = new Uint8Array(
  Array.from(standardEhControl).concat(standardEhFeatures),
);

function guest(extra: number[] = []) {
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [1, 0x60, 0, 1, 0x7f]),
      section(3, [1, 0]),
      section(5, [1, 1, 1].concat(integer(4096))),
      section(7, [2].concat(text("value"), [0, 0], text("memory"), [2, 0])),
      section(10, [1, 4, 0, 0x41, 7, 0x0b]),
      custom("name", section(1, [1, 0].concat(text("value")))),
      extra,
    ),
  );
}

function fixture(run: (source: string, destination: string, directory: string) => void) {
  const parent = resolve(process.env.PROGRAM_OPTIMIZER_TEST_ROOT ?? ".build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "optimizer-test-"));
  try {
    const source = resolve(directory, "compiler.wasm");
    const destination = resolve(directory, "staged.wasm");
    writeFileSync(source, guest());
    writeFileSync(destination, "accepted destination");
    run(source, destination, directory);
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith(".program-optimize-")),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verify(path: string) {
  verifyWasiGuest(path);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)));
  const value = instance.exports.value;
  assert.equal(typeof value, "function");
  assert.ok(typeof value === "function");
  assert.equal(value(), 7);
}

test("policy covers every program family and leaves non-Wasm packages explicit", () => {
  assert.deepEqual(programOptimizationCoverage, {
    coreutils: "wasm",
    findutils: "wasm",
    grep: "wasm",
    sed: "wasm",
    ripgrep: "wasm",
    python: "wasm",
    git: "already-minified-javascript",
    base: "aggregate-without-binary",
  });
  assert.deepEqual(programCOptimizationFlags, ["-Oz", "-flto"]);
  assert.equal(programReleaseEnvironment.CARGO_PROFILE_RELEASE_OPT_LEVEL, "z");
  assert.equal(programReleaseEnvironment.CARGO_PROFILE_RELEASE_LTO, "fat");
  assert.equal(programReleaseEnvironment.CARGO_PROFILE_RELEASE_PANIC, "abort");
  assert.equal(programReleaseEnvironment.CARGO_PROFILE_RELEASE_CODEGEN_UNITS, "1");
  assert.ok(
    programOptimizationFlags.indexOf("--no-inline=__wasilibc_populate_preopens") <
      programOptimizationFlags.indexOf("-Oz"),
  );
  assert.ok(programOptimizationFlags.includes("-g"));
  assert.ok(
    !Array.from(programOptimizationFlags, String).some((flag) =>
      /fast-math|closed-world|no-validation|all-features|strip-debug|strip-target-features|strip-producers/.test(
        flag,
      ),
    ),
  );
});

test("optimized bytes are verified before replacing staged output and receipts are reproducible", () => {
  fixture((source, destination, directory) => {
    const input = readFileSync(source);
    const producerReceipt = resolve(directory, "python-build.json");
    writeFileSync(producerReceipt, '{"producer":"original accepted receipt"}\n');
    const receiptBytes = readFileSync(producerReceipt);
    let verified = false;
    const recipe = {
      source,
      destination,
      producerReceipt,
      verify: (path: string) => {
        assert.equal(readFileSync(destination, "utf8"), "accepted destination");
        assert.ok(
          WebAssembly.Module.customSections(new WebAssembly.Module(readFileSync(path)), "name")
            .length > 0,
        );
        verify(path);
        verified = true;
      },
    };
    const first = optimizeProgram(recipe);
    assert.ok(verified);
    assert.deepEqual(readFileSync(source), input);
    assert.deepEqual(readFileSync(producerReceipt), receiptBytes);
    assert.deepEqual(first.input, { bytes: input.length, sha256: hash(input) });
    assert.deepEqual(first.output, {
      bytes: readFileSync(destination).length,
      sha256: hash(readFileSync(destination)),
    });
    assert.deepEqual(first.producerReceipt, {
      bytes: receiptBytes.length,
      sha256: hash(receiptBytes),
    });
    const second = optimizeProgram({ ...recipe, verify });
    assert.deepEqual(second, first);
  });
});

test("invocation uses fixed features, single-thread environment and only private compiler copies", () => {
  fixture((source, destination) => {
    const execute: NonNullable<OptimizerOptions["execute"]> = (command, args, options) => {
      const argv = Array.from(args ?? [], String);
      if (argv[0] === "--version") return execFileSync(command, args, options);
      assert.ok(argv[0] !== source);
      assert.deepEqual(argv.slice(1, -2), Array.from(programOptimizationFlags));
      assert.deepEqual(options?.env, { BINARYEN_CORES: "1", LC_ALL: "C", TZ: "UTC" });
      assert.equal(argv.at(-2), "-o");
      assert.notEqual(argv.at(-1), destination);
      return execFileSync(command, args, options);
    };
    optimizeProgram({ source, destination, verify }, { execute });
  });
});

for (const mode of ["command-failed", "malformed-output", "verifier-rejected"]) {
  test(`${mode} never replaces accepted output or mutates compiler input`, () => {
    fixture((source, destination) => {
      const input = readFileSync(source);
      const execute: NonNullable<OptimizerOptions["execute"]> = (command, args, options) => {
        const argv = Array.from(args ?? [], String);
        if (argv[0] === "--version") return execFileSync(command, args, options);
        if (mode === "command-failed") throw new Error(mode);
        if (mode !== "malformed-output") return execFileSync(command, args, options);
        const output = argv.at(-1);
        assert.ok(output);
        writeFileSync(output, "not wasm");
        return Buffer.alloc(0);
      };
      const reject = () => {
        throw new Error("verifier-rejected");
      };
      assert.throws(() =>
        optimizeProgram(
          { source, destination, verify: mode === "verifier-rejected" ? reject : verify },
          { execute },
        ),
      );
      assert.equal(readFileSync(destination, "utf8"), "accepted destination");
      assert.deepEqual(readFileSync(source), input);
    });
  });
}

test("untrusted tool binaries and version drift are rejected", () => {
  fixture((source, destination, directory) => {
    const executable = resolve(directory, "untrusted-wasm-opt");
    writeFileSync(executable, "not the pinned tool");
    assert.throws(
      () => optimizeProgram({ source, destination, verify }, { executable }),
      /Unpinned wasm-opt/,
    );
    const execute: NonNullable<OptimizerOptions["execute"]> = () =>
      Buffer.from("wasm-opt version 132");
    assert.throws(
      () => optimizeProgram({ source, destination, verify }, { execute }),
      /Unexpected wasm-opt version/,
    );
    assert.equal(readFileSync(destination, "utf8"), "accepted destination");
  });
});

for (const alias of ["same-path", "symlink", "hardlink"]) {
  test(`compiler source cannot be replaced through ${alias}`, () => {
    fixture((source, destination, directory) => {
      const target = resolve(directory, `${alias}.wasm`);
      if (alias === "symlink") symlinkSync(source, target);
      if (alias === "hardlink") linkSync(source, target);
      assert.throws(() =>
        optimizeProgram({ source, destination: alias === "same-path" ? source : target, verify }),
      );
      assert.ok(WebAssembly.validate(readFileSync(source)));
      assert.equal(readFileSync(destination, "utf8"), "accepted destination");
    });
  });
}

test("relocation offsets are never copied across transformed code", () => {
  fixture((source, destination) => {
    writeFileSync(source, guest(custom("reloc.CODE", [0, 0])));
    assert.throws(() => optimizeProgram({ source, destination, verify }), /must be linked/);
    assert.equal(readFileSync(destination, "utf8"), "accepted destination");
  });
});

test("dynamic linking and target feature metadata survive optimization", () => {
  fixture((source, destination) => {
    writeFileSync(
      source,
      guest(
        custom("dylink.0", [1, 4, 0, 0, 0, 0]).concat(
          custom("target_features", [1, 0x2b].concat(text("mutable-globals"))),
        ),
      ),
    );
    optimizeProgram({ source, destination, verify });
    for (const name of ["dylink.0"]) {
      const before = new WebAssembly.Module(readFileSync(source));
      const after = new WebAssembly.Module(readFileSync(destination));
      assert.deepEqual(
        WebAssembly.Module.customSections(after, name),
        WebAssembly.Module.customSections(before, name),
      );
    }
    const module = new WebAssembly.Module(readFileSync(destination));
    const features = WebAssembly.Module.customSections(module, "target_features")[0];
    assert.ok(features);
    assert.ok(new TextDecoder().decode(features).includes("mutable-globals"));
  });
});

test("standard EH optimization preserves tags, target features and nonlocal exits", () => {
  fixture((source, destination) => {
    writeFileSync(source, withStandardEhFeatures);
    const before = new WebAssembly.Module(withStandardEhFeatures);
    optimizeProgram({
      source,
      destination,
      verify: (path) => {
        const module = new WebAssembly.Module(readFileSync(path));
        const instance = new WebAssembly.Instance(module);
        const run = instance.exports.run;
        assert.ok(typeof run === "function");
        assert.equal(run(), 7);
      },
    });
    const output = readFileSync(destination);
    const after = new WebAssembly.Module(output);
    assert.deepEqual(WebAssembly.Module.imports(after), WebAssembly.Module.imports(before));
    assert.deepEqual(WebAssembly.Module.exports(after), WebAssembly.Module.exports(before));
    assert.equal(WebAssembly.Module.customSections(after, "target_features").length, 1);
    assert.equal(WebAssembly.Module.customSections(after, "name").length, 1);
  });
});

test("malformed standard EH tags fail closed before optimization", () => {
  fixture((source, destination) => {
    const malformed = new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        signatures(signature([], [])),
        section(13, [1, 1, 0]),
      ),
    );
    writeFileSync(source, malformed);
    assert.throws(
      () => optimizeProgram({ source, destination, verify }),
      WebAssembly.CompileError,
    );
  });
});

test("optimizer preserves target features Binaryen does not model", () => {
  fixture((source, destination) => {
    writeFileSync(
      source,
      guest(custom("target_features", [1, 0x2b].concat(text("call-indirect-overlong")))),
    );
    optimizeProgram({ source, destination, verify });
    const features = WebAssembly.Module.customSections(
      new WebAssembly.Module(readFileSync(destination)),
      "target_features",
    )[0];
    assert.ok(features);
    assert.ok(new TextDecoder().decode(features).includes("call-indirect-overlong"));
  });
});

test("provisioning action pins the same archive, executable and version as the helper", () => {
  const action = readFileSync(
    new URL("../.github/actions/program-optimizer/action.yml", import.meta.url),
    "utf8",
  );
  for (const expected of [
    programOptimizer.version,
    programOptimizer.archive,
    programOptimizer.archiveSha256,
    programOptimizer.linuxX64Sha256,
  ])
    assert.ok(action.includes(expected), expected);
  assert.match(action, /cache-hit != 'true'/);
  assert.match(action, /trap .* EXIT/);
});

for (const [feature, prefix, expected] of [
  ["threads", 0x2b, /Unsupported program target feature/],
  ["mutable-globals", 0x2d, /Optimizer changed target feature/],
] as const) {
  test(`unsupported or contradicted feature ${prefix}:${feature} leaves accepted output intact`, () => {
    fixture((source, destination) => {
      writeFileSync(source, guest(custom("target_features", [1, prefix].concat(text(feature)))));
      assert.throws(() => optimizeProgram({ source, destination, verify }), expected);
      assert.equal(readFileSync(destination, "utf8"), "accepted destination");
    });
  });
}

test("a verifier cannot silently change candidate bytes", () => {
  fixture((source, destination) => {
    const verify = (path: string) => writeFileSync(path, guest(custom("altered", [1])));
    assert.throws(() => optimizeProgram({ source, destination, verify }), /Verifier changed/);
    assert.equal(readFileSync(destination, "utf8"), "accepted destination");
  });
});

test("unused imports survive the selected optimization policy", () => {
  fixture((source, destination) => {
    const bytes = new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 0x60, 0, 1, 0x7f]),
        section(2, [1].concat(text("env"), text("unused"), [0, 0])),
        section(3, [1, 0]),
        section(5, [1, 1, 1].concat(integer(4096))),
        section(7, [1].concat(text("value"), [0, 1])),
        section(10, [1, 4, 0, 0x41, 7, 0x0b]),
      ),
    );
    writeFileSync(source, bytes);
    optimizeProgram({ source, destination, verify: (path) => verifyWasiGuest(path) });
    const module = new WebAssembly.Module(readFileSync(destination));
    assert.deepEqual(WebAssembly.Module.imports(module), [
      { module: "env", name: "unused", kind: "function" },
    ]);
    const instance = new WebAssembly.Instance(module, { env: { unused: () => 9 } });
    assert.ok(typeof instance.exports.value === "function");
    assert.equal(instance.exports.value(), 7);
  });
});

test("optimized infinite loops still receive real interrupt checkpoints", () => {
  fixture((source, destination) => {
    const bytes = new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 0x60, 0, 0]),
        section(3, [1, 0]),
        section(5, [1, 1, 1].concat(integer(4096))),
        section(7, [1].concat(text("run"), [0, 0])),
        section(10, [1, 7, 0, 0x03, 0x40, 0x0c, 0, 0x0b, 0x0b]),
      ),
    );
    writeFileSync(source, bytes);
    optimizeProgram({ source, destination, verify: (path) => verifyWasiGuest(path) });
    const rewriter = new URL("../packages/waffle/interrupt/rewriter.ts", import.meta.url).href;
    const script = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rewriteInterrupts } from ${JSON.stringify(rewriter)};
const bytes = rewriteInterrupts(readFileSync(process.argv[1]), { interval: 7 });
let calls = 0;
const module = new WebAssembly.Module(bytes);
const instance = new WebAssembly.Instance(module, { runtime_proc: { __waffle_fatal: () => ++calls === 3 ? 2 : 0 } });
assert.throws(() => instance.exports.run(), WebAssembly.RuntimeError);
assert.equal(calls, 3);
`;
    const result = spawnSync(process.execPath, ["--eval", script, destination], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("size optimization drops DWARF but keeps verifier function names", () => {
  fixture((source, destination) => {
    writeFileSync(source, guest(custom(".debug_info", [0, 0, 0, 0])));
    optimizeProgram({ source, destination, verify });
    const module = new WebAssembly.Module(readFileSync(destination));
    assert.equal(WebAssembly.Module.customSections(module, ".debug_info").length, 0);
    assert.equal(WebAssembly.Module.customSections(module, "name").length, 1);
  });
});

test("root and independent sed profiles use the selected size policy", () => {
  for (const path of ["../Cargo.toml", "../packages/sed/Cargo.toml"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const profile = source.split("[profile.release]")[1]?.split("\n[")[0];
    assert.ok(profile);
    assert.match(profile, /opt-level = "z"/);
    assert.match(profile, /lto = "fat"/);
    assert.match(profile, /panic = "abort"/);
    assert.match(profile, /codegen-units = 1/);
    assert.match(profile, /strip = "debuginfo"/);
  }
});
