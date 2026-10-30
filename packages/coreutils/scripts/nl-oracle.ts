import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";
import { nlCases, type NlCase } from "../fixtures/nl-cases.ts";

const environment = { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "en_US", TZ: "UTC" };
const script = fileURLToPath(import.meta.url);

function inputBytes(value: NlCase["input"]): Uint8Array {
  return typeof value === "string" ? Buffer.from(value) : Uint8Array.from(value);
}

async function runGuest(path: string, args: string[]) {
  const wasi = new WASI({
    version: "preview1",
    args: ["nl"].concat(args),
    env: { ...environment, PWD: "/" },
    preopens: { "/": process.cwd() },
    returnOnExit: true,
  });
  const module = await WebAssembly.compile(readFileSync(path));
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  process.exitCode = wasi.start(instance);
}

export interface OracleResult {
  readonly name: string;
  readonly kind: string;
  readonly status: number;
  readonly gnuStatus: number;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
}

function compareCase(wasm: string, directory: string, fixture: NlCase): OracleResult {
  for (const [name, contents] of Object.entries(fixture.files ?? {})) {
    writeFileSync(resolve(directory, name), contents);
  }
  const input = inputBytes(fixture.input);
  const options = {
    cwd: directory,
    env: environment,
    input,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  };
  const gnu = spawnSync(process.env.GNU_NL ?? "/usr/bin/nl", fixture.args, options);
  const guest = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", script, "--guest", wasm].concat(fixture.args),
    options,
  );
  assert.ifError(gnu.error);
  assert.ifError(guest.error);
  assert.equal(gnu.signal, null, fixture.name);
  assert.equal(guest.signal, null, fixture.name);
  assert.equal(guest.status, fixture.status, `${fixture.name}: ${guest.stderr}`);
  verifyComparison(fixture, gnu, guest);
  return {
    name: fixture.name,
    kind: fixture.kind ?? "comparison",
    status: guest.status ?? -1,
    gnuStatus: gnu.status ?? -1,
    stdoutBytes: guest.stdout.length,
    stdoutSha256: createHash("sha256").update(guest.stdout).digest("hex"),
  };
}

type Result = SpawnSyncReturns<Buffer>;

function verifyComparison(fixture: NlCase, gnu: Result, guest: Result) {
  if (fixture.kind === "unsupported") {
    assert.equal(gnu.status, 0);
    assert.match(guest.stderr.toString(), /backreferences are not supported/);
    assert.equal(guest.stdout.length, 0);
    return;
  }
  assert.equal(guest.status, gnu.status, fixture.name);
  if (fixture.kind === "metadata") {
    assert.match(guest.stdout.toString(), /nl/);
    assert.equal(guest.stderr.length, 0);
    return;
  }
  assert.deepEqual(guest.stdout, gnu.stdout, fixture.name);
  assert.equal(
    guest.stderr.length > 0,
    gnu.stderr.length > 0,
    `${fixture.name}: diagnostic presence`,
  );
}

export function compareNl(wasm: string): OracleResult[] {
  const root = process.env.NL_SCRATCH_ROOT;
  assert.ok(root, "Set NL_SCRATCH_ROOT to a verified data-drive scratch directory");
  const directory = mkdtempSync(resolve(root, "nl-oracle-"));
  try {
    return nlCases.map((fixture) => compareCase(resolve(wasm), directory, fixture));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [mode, path, ...args] = process.argv.slice(2);
  assert.ok(path, "Usage: node nl-oracle.ts --compare|--guest /absolute/nl.wasm [guest args]");
  if (mode === "--guest") await runGuest(path, args);
  else {
    assert.equal(mode, "--compare");
    console.log(
      JSON.stringify(
        {
          gnu: spawnSync(process.env.GNU_NL ?? "/usr/bin/nl", ["--version"], { env: environment })
            .stdout.toString()
            .split("\n")[0],
          guestSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
          cases: compareNl(path),
        },
        null,
        2,
      ),
    );
  }
}
