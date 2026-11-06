import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";
import { sleepCases, type SleepCase } from "../fixtures/sleep-cases.ts";
import source from "../provenance/sleep.source.json" with { type: "json" };

const script = fileURLToPath(import.meta.url);
const environment = { ...process.env, ...source.oracle.environment };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function verifyGnuSleep() {
  const path = resolve(process.env.GNU_SLEEP ?? source.oracle.path);
  assert.equal(sha256(readFileSync(path)), source.oracle.sha256, "GNU sleep bytes changed");
  const result = spawnSync(path, ["--version"], {
    env: environment,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const version = result.stdout.split("\n")[0];
  assert.equal(version, source.oracle.version);
  return { path, version, sha256: source.oracle.sha256 };
}

function observation(result: SpawnSyncReturns<Buffer>) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, null);
  return {
    status: result.status,
    stdout: result.stdout.toString("base64"),
    stderr: result.stderr.toString("base64"),
  };
}

function compare(
  fixture: SleepCase,
  actual: ReturnType<typeof observation>,
  expected: ReturnType<typeof observation>,
) {
  assert.equal(actual.status, fixture.status, fixture.name);
  assert.equal(actual.status, expected.status, fixture.name);
  if (fixture.kind === "metadata") {
    assert.match(Buffer.from(actual.stdout, "base64").toString(), /sleep/);
    assert.equal(actual.stderr, "");
    return;
  }
  assert.equal(actual.stdout, expected.stdout, fixture.name);
  assert.equal(actual.stderr.length > 0, expected.stderr.length > 0, fixture.name);
}

async function runGuest(path: string, args: string[]) {
  const wasi = new WASI({
    version: "preview1",
    args: ["sleep"].concat(args),
    env: environment,
    returnOnExit: true,
  });
  const module = await WebAssembly.compile(readFileSync(path));
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  process.exitCode = wasi.start(instance);
}

async function cancellation(command: string, args: string[]) {
  const child = spawn(command, args, { env: environment, stdio: "ignore" });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  const kill = setTimeout(() => child.kill("SIGINT"), 250);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const exit = await result;
    assert.equal(exit.signal, "SIGINT", "sleep did not remain alive until cancellation");
    return { args, ...exit, pid: child.pid, stopped: true };
  } finally {
    clearTimeout(kill);
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await result;
  }
}

export async function compareSleep(wasm: string, native?: string) {
  const oracle = verifyGnuSleep();
  const guestArgs = ["--disable-warning=ExperimentalWarning", script, "--guest", resolve(wasm)];
  const cases = sleepCases.map((fixture) => {
    const options = {
      env: environment,
      timeout: 5_000,
      killSignal: "SIGKILL" as const,
      maxBuffer: 64 * 1024,
    };
    const expected = observation(spawnSync(oracle.path, fixture.args, options));
    const actual = observation(
      spawnSync(process.execPath, guestArgs.concat(fixture.args), options),
    );
    compare(fixture, actual, expected);
    const nativeResult = native
      ? observation(spawnSync(resolve(native), fixture.args, options))
      : undefined;
    if (nativeResult) compare(fixture, nativeResult, expected);
    return {
      name: fixture.name,
      kind: fixture.kind,
      args: fixture.args,
      expected,
      actual,
      native: nativeResult,
    };
  });
  return {
    scope: "Node WASI transport comparison only, not Waffle runtime acceptance",
    oracle,
    guestSha256: sha256(readFileSync(wasm)),
    nativeSha256: native ? sha256(readFileSync(native)) : null,
    cases,
    cancellation: {
      gnu: await cancellation(oracle.path, ["30"]),
      nodeWasi: await cancellation(process.execPath, guestArgs.concat(["30"])),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [mode, path, ...args] = process.argv.slice(2);
  assert.ok(
    path,
    "Use --compare /absolute/sleep.wasm [native-sleep] or --guest /absolute/sleep.wasm [arguments]",
  );
  if (mode === "--guest") await runGuest(path, args);
  else {
    assert.equal(mode, "--compare");
    console.log(JSON.stringify(await compareSleep(path, args[0]), null, 2));
  }
}
