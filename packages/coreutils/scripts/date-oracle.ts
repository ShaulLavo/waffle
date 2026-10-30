import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";
import { currentDateCases, dateCases, fixedTime, type DateCase } from "../fixtures/date-cases.ts";
import source from "../provenance/date.source.json" with { type: "json" };

import { verifyNativeDate } from "./build-native-date-oracle.ts";
import { assertSafeNativeDateArgs } from "./safe-native-date.ts";

const environment = { ...process.env, ...source.oracle.environment };
const script = fileURLToPath(import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function verifyGnuDate() {
  const oracle = verifyNativeDate();
  assert.ok(process.env.GNU_DATE, "Set GNU_DATE to the owned, verified GNU 9.12 cache binary");
  assert.equal(resolve(process.env.GNU_DATE), oracle.path);
  assert.equal(oracle.version, source.oracle.version);
  return oracle;
}

function runGnuDate(path: string, args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding) {
  assertSafeNativeDateArgs(args);
  return spawnSync(path, args, { ...options, argv0: "date" });
}

async function runGuest(path: string, args: string[]) {
  const wasi = new WASI({
    version: "preview1",
    args: ["date"].concat(args),
    env: { ...environment, TZ: process.env.TZ ?? "UTC0", PWD: "/" },
    preopens: { "/": process.cwd() },
    returnOnExit: true,
  });
  let memory: WebAssembly.Memory | undefined;
  let reads = 0;
  const imports = {
    ...wasi.wasiImport,
    clock_time_get(id: number, precision: bigint, pointer: number) {
      if (id !== 0) return wasi.wasiImport.clock_time_get(id, precision, pointer);
      assert.ok(memory);
      new DataView(memory.buffer).setBigUint64(pointer, fixedTime.nanoseconds, true);
      reads++;
      return 0;
    },
  };
  const module = await WebAssembly.compile(readFileSync(path));
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports });
  assert.ok(instance.exports.memory instanceof WebAssembly.Memory);
  memory = instance.exports.memory;
  process.exitCode = wasi.start(instance);
  if (process.exitCode === 0 && !args.includes("--help") && !args.includes("--version"))
    assert.ok(reads > 0, "date did not read the declared WASI clock fixture");
}

function completed(result: SpawnSyncReturns<Buffer>, name: string) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, name);
  assert.notEqual(result.status, null, name);
  return result;
}

function compareOutput(
  fixture: DateCase,
  actual: SpawnSyncReturns<Buffer>,
  expected?: SpawnSyncReturns<Buffer>,
) {
  assert.equal(actual.status, fixture.status, `${fixture.name}: ${actual.stderr}`);
  if (fixture.kind === "unsupported") {
    assert.equal(actual.stdout.length, 0, fixture.name);
    assert.match(actual.stderr.toString(), /setting the clock is not supported/);
    return;
  }
  assert.ok(expected);
  assert.equal(actual.status, expected.status, fixture.name);
  if (fixture.kind === "metadata") {
    assert.match(actual.stdout.toString(), /date/);
    assert.equal(actual.stderr.length, 0);
    return;
  }
  assert.deepEqual(actual.stdout, expected.stdout, fixture.name);
  assert.equal(actual.stderr.length > 0, expected.stderr.length > 0, fixture.name);
}

export function compareDate(wasm: string, native?: string) {
  const oracle = verifyGnuDate();
  const root = process.env.DATE_SCRATCH_ROOT;
  assert.ok(root, "Set DATE_SCRATCH_ROOT to a verified data-drive directory");
  const directory = mkdtempSync(resolve(root, "date-oracle-"));
  try {
    writeFileSync(resolve(directory, "reference"), "real fixture file\n");
    utimesSync(resolve(directory, "reference"), 1709210096, 1709210096);
    writeFileSync(resolve(directory, "dates"), "@0\n2024-02-29 12:34:56 UTC\n");
    const results = dateCases.map((fixture) => {
      const options = {
        cwd: directory,
        env: { ...environment, TZ: fixture.tz ?? "UTC0" },
        input: fixture.input ?? "",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      };
      // Never invoke a native oracle with a clock-setting option.
      const expected =
        fixture.kind === "unsupported"
          ? undefined
          : completed(runGnuDate(oracle.path, fixture.args, options), fixture.name);
      const actual = completed(
        spawnSync(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", script, "--guest", resolve(wasm)].concat(
            fixture.args,
          ),
          options,
        ),
        fixture.name,
      );
      compareOutput(fixture, actual, expected);
      if (native && fixture.kind !== "unsupported")
        compareOutput(
          fixture,
          completed(spawnSync(resolve(native), fixture.args, options), fixture.name),
          expected,
        );
      return {
        name: fixture.name,
        status: actual.status,
        stdoutBytes: actual.stdout.length,
        stdoutSha256: sha256(actual.stdout),
        nativeCompared: Boolean(native) && fixture.kind !== "unsupported",
      };
    });
    return {
      oracle,
      guestSha256: sha256(readFileSync(wasm)),
      nativeSha256: native ? sha256(readFileSync(native)) : null,
      clockFixture: {
        nanoseconds: String(fixedTime.nanoseconds),
        scope: "Node WASI oracle only; production runtime clock is unchanged",
      },
      cases: results.concat(compareCurrent(wasm, directory, oracle.path)),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function compareCurrent(wasm: string, cwd: string, gnu: string) {
  return currentDateCases.map((fixture) => {
    const options = { cwd, env: environment, timeout: 10_000, maxBuffer: 1024 * 1024 };
    const expected = completed(
      runGnuDate(gnu, ["-d", fixedTime.epoch].concat(fixture.args), options),
      fixture.name,
    );
    const actual = completed(
      spawnSync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", script, "--guest", resolve(wasm)].concat(
          fixture.args,
        ),
        options,
      ),
      fixture.name,
    );
    compareOutput({ ...fixture, status: 0 }, actual, expected);
    return {
      name: fixture.name,
      status: actual.status,
      stdoutBytes: actual.stdout.length,
      stdoutSha256: sha256(actual.stdout),
      nativeCompared: false,
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [mode, path, ...args] = process.argv.slice(2);
  assert.ok(
    path,
    "Use --compare /absolute/date.wasm [native-date] or --guest /absolute/date.wasm [arguments]",
  );
  if (mode === "--guest") await runGuest(path, args);
  else {
    assert.equal(mode, "--compare");
    console.log(JSON.stringify(compareDate(path, args[0]), null, 2));
  }
}
