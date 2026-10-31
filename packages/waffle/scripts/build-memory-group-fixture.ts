import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Builds the memory group browser fixture once, with wasi-sdk 34, and records a receipt that
// binds the wasm to its exact inputs. CI builds it in the libc job and the browser gate
// consumes the artifact after verifying the receipt against the checked-out sources.
//   bun scripts/build-memory-group-fixture.ts <outdir>           (needs WASI_SDK_PATH)
//   bun scripts/build-memory-group-fixture.ts --verify <outdir>

const root = resolve(import.meta.dir, "..");
const source = join(root, "tests/fixtures/memory-group-member.c");
const COMPILE = [
  "--target=wasm32-wasip1",
  "-nostdlib",
  "-O2",
  "-fPIC",
  "-matomics",
  "-mbulk-memory",
];
const LINK = [
  "-pie",
  "--experimental-pic",
  "--import-memory",
  "--shared-memory",
  "--max-memory=4294967296",
  "--import-table",
  "--no-entry",
  "--export=_start",
];
/** The explicit initializer the link plan names, replacing wasm-ld's start function. */
const MEMORY_GROUP_FIXTURE_INIT = "member_initialize_memory";
const MEMORY_GROUP_FIXTURE_WASM = "memory-group-member.wasm";
const RECEIPT = "memory-group-member.json";

interface FixtureReceipt {
  readonly inputs: string;
  readonly wasm: string;
  readonly compiler: string;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Hash of every input that determines the fixture bytes, except the pinned SDK itself. */
function fixtureInputs(): string {
  return sha256(
    JSON.stringify({
      source: sha256(readFileSync(source)),
      builder: sha256(readFileSync(import.meta.path)),
      compile: COMPILE,
      link: LINK,
    }),
  );
}

function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 0x7f) | (next ? 0x80 : 0));
    value = next;
  } while (value);
  return bytes;
}
function readLeb(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = bytes[at++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [value, at];
  }
}

/** wasm-ld emits the shared-memory initializer as a start function; export it instead. */
function explicitInitializer(bytes: Uint8Array): Uint8Array {
  let out: number[] = Array.from(bytes.subarray(0, 8));
  let start: number | undefined;
  const sections: { id: number; body: Uint8Array }[] = [];
  for (let at = 8; at < bytes.length;) {
    const id = bytes[at]!;
    const [size, body] = readLeb(bytes, at + 1);
    sections.push({ id, body: bytes.subarray(body, body + size) });
    at = body + size;
  }
  for (const section of sections) if (section.id === 8) start = readLeb(section.body, 0)[0];
  if (start === undefined) throw new Error("fixture has no start function to make explicit");
  for (const section of sections) {
    if (section.id === 8) continue;
    let body = Array.from(section.body);
    if (section.id === 7) {
      const [count, at] = readLeb(section.body, 0);
      const name = Array.from(new TextEncoder().encode(MEMORY_GROUP_FIXTURE_INIT));
      body = leb(count + 1).concat(body.slice(at), leb(name.length), name, [0], leb(start));
    }
    out = out.concat([section.id], leb(body.length), body);
  }
  return new Uint8Array(out);
}

function run(command: string[]): void {
  const child = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) throw new Error(`${command[0]} failed`);
}

export function buildFixture(outdir: string, sdk = process.env.WASI_SDK_PATH): FixtureReceipt {
  if (!sdk) throw new Error("WASI_SDK_PATH must name a wasi-sdk 34 installation");
  mkdirSync(outdir, { recursive: true });
  const object = join(outdir, "memory-group-member.o"),
    linked = join(outdir, "memory-group-member.pie.wasm");
  try {
    run([`${sdk}/bin/clang`].concat(COMPILE, ["-c", source, "-o", object]));
    run([`${sdk}/bin/wasm-ld`].concat(LINK, [object, "-o", linked]));
    const wasm = explicitInitializer(readFileSync(linked));
    const version = Bun.spawnSync([`${sdk}/bin/clang`, "--version"]).stdout.toString();
    const receipt = {
      inputs: fixtureInputs(),
      wasm: sha256(wasm),
      compiler: version.split("\n")[0]!,
    };
    writeFileSync(join(outdir, MEMORY_GROUP_FIXTURE_WASM), wasm);
    writeFileSync(join(outdir, RECEIPT), JSON.stringify(receipt, null, 1) + "\n");
    return receipt;
  } finally {
    rmSync(object, { force: true });
    rmSync(linked, { force: true });
  }
}

/** The verified fixture bytes; a stale or altered artifact fails instead of running. */
export function verifiedFixture(outdir: string): Uint8Array {
  const receipt = JSON.parse(readFileSync(join(outdir, RECEIPT), "utf8")) as FixtureReceipt;
  const wasm = readFileSync(join(outdir, MEMORY_GROUP_FIXTURE_WASM));
  if (receipt.inputs !== fixtureInputs())
    throw new Error("memory group fixture was built from other inputs; rebuild it");
  if (receipt.wasm !== sha256(wasm)) throw new Error("memory group fixture bytes do not match");
  return wasm;
}

if (import.meta.main) {
  const [flag, directory] = process.argv.slice(2);
  if (flag === "--verify" && directory) {
    verifiedFixture(resolve(directory));
    console.log("memory group fixture verified");
  } else if (flag && !directory) {
    console.log(JSON.stringify(buildFixture(resolve(flag))));
  } else throw new Error("usage: build-memory-group-fixture.ts <outdir> | --verify <outdir>");
}
