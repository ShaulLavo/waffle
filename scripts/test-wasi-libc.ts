import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addStartSection } from "../tests/fixtures/wasm-start-section.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sdk = process.env.WASI_SDK_PATH ?? "/work/cache/wasi-sdk-34.0-x86_64-linux";
const scratch = process.env.WASI_LIBC_SCRATCH_ROOT ?? "/work/tmp";
const root = mkdtempSync(join(scratch, "waffle-preopen-test-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted = false;
const interrupt = () => { interrupted = true; child?.kill("SIGTERM"); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function run(command: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (interrupted) throw new Error("test interrupted");
  child = Bun.spawn(command, { cwd: repo, env, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  child = undefined;
  if (code !== 0 || interrupted) throw new Error(`${command[0]} failed (${code})`);
}
try {
  const sysroot = join(root, "sysroot");
  await run(["bash", join(repo, "scripts/build-wasi-libc.sh"), sysroot]);
  for (const flavor of ["patched", "stock"]) {
    for (const start of [false, true]) {
      const file = join(root, `${flavor}${start ? "-start" : ""}.wasm`);
      const args = [join(sdk, "bin/clang"), "--target=wasm32-wasip1", "-O2", "-Wl,--initial-memory=262144", "-Wl,--max-memory=16777216", "-Wl,--export-memory"];
      if (flavor === "patched") args.push(`--sysroot=${sysroot}`);
      if (start) args.push("-Wl,--import-memory");
      await run(args.concat([join(repo, "tests/fixtures/preopen-guest.c"), "-o", file]));
      if (start) writeFileSync(file, addStartSection(new Uint8Array(await Bun.file(file).arrayBuffer()), "early_preopens"));
    }
  }
  await run(["bun", "test", "./tests/wasi-libc.test.ts"], { ...process.env, WAFFLE_LIBC_FIXTURES: root });
  writeFileSync(join(root, "fixture"), "fixture");
  await run([process.env.WASMTIME ?? "/work/cache/wasm-tools/wasmtime/wasmtime", "run", "--dir", `${root}::/`, join(root, "patched.wasm")]);
  // A second stock host proves that the patch adds no Waffle-only import requirement.
  await run(["node", "--disable-warning=ExperimentalWarning", join(repo, "tests/fixtures/preopen-node-host.ts"), join(root, "patched.wasm"), root]);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  rmSync(root, { recursive: true, force: true });
}
