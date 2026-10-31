import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addStartSection } from "../tests/fixtures/wasm-start-section.ts";
import { CommandCleanupError, runOwned } from "./owned-command.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sdk = process.env.WASI_SDK_PATH ?? "/work/cache/wasi-sdk-34.0-x86_64-linux";
const scratch = process.env.WASI_LIBC_SCRATCH_ROOT ?? "/work/tmp";
const root = mkdtempSync(join(scratch, "waffle-preopen-test-"));
const temporary = join(root, "tmp");
mkdirSync(temporary);
const controller = new AbortController();
let safeToRemove = true;
const interrupt = () => {
  controller.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function run(command: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await runOwned(command, {
      cwd: repo,
      signal: controller.signal,
      env: { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    });
  } catch (error) {
    if (error instanceof CommandCleanupError) safeToRemove = false;
    throw error;
  }
}
async function buildFixtures(): Promise<void> {
  const sysroot = process.env.WASI_LIBC_SYSROOT_CACHE ?? join(root, "sysroot");
  if (!existsSync(sysroot)) await run(["bash", join(repo, "scripts/build-wasi-libc.sh"), sysroot]);
  await run([
    join(sdk, "bin/clang"),
    "--target=wasm32-wasip1",
    `--sysroot=${sysroot}`,
    "-O2",
    join(repo, "tests/fixtures/preview1-socket.c"),
    "-o",
    join(root, "socket.wasm"),
  ]);
  for (const flavor of ["patched", "stock"]) {
    for (const start of [false, true]) {
      const file = join(root, `${flavor}${start ? "-start" : ""}.wasm`);
      const args = [
        join(sdk, "bin/clang"),
        "--target=wasm32-wasip1",
        "-O2",
        "-Wl,--initial-memory=262144",
        "-Wl,--max-memory=16777216",
        "-Wl,--export-memory",
      ];
      if (flavor === "patched") args.push(`--sysroot=${sysroot}`);
      if (start) args.push("-Wl,--import-memory");
      await run(args.concat([join(repo, "tests/fixtures/preopen-guest.c"), "-o", file]));
      if (start)
        writeFileSync(
          file,
          addStartSection(new Uint8Array(await Bun.file(file).arrayBuffer()), "early_preopens"),
        );
    }
  }
}

const cache = process.env.WASI_LIBC_FIXTURE_CACHE;
const fixtures = cache && existsSync(cache) ? cache : root;
const fixtureNames = [
  "patched.wasm",
  "patched-start.wasm",
  "stock.wasm",
  "stock-start.wasm",
  "socket.wasm",
];
try {
  if (fixtures === root) await buildFixtures();
  else console.log(`Using cached wasi-libc fixtures: ${fixtures}`);
  await run(["bun", "test", "./tests/wasi-libc.test.ts", "./tests/preview1-socket-libc.test.ts"], {
    ...process.env,
    WAFFLE_LIBC_FIXTURES: fixtures,
  });
  writeFileSync(join(root, "fixture"), "fixture");
  await run([
    process.env.WASMTIME ?? "/work/cache/wasm-tools/wasmtime/wasmtime",
    "run",
    "--dir",
    `${root}::/`,
    join(fixtures, "patched.wasm"),
  ]);
  // A second stock host proves that the patch adds no Waffle-only import requirement.
  await run([
    "node",
    "--disable-warning=ExperimentalWarning",
    join(repo, "tests/fixtures/preopen-node-host.ts"),
    join(fixtures, "patched.wasm"),
    root,
  ]);
  if (cache && fixtures === root) {
    mkdirSync(cache);
    for (const name of fixtureNames) copyFileSync(join(root, name), join(cache, name));
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (safeToRemove) rmSync(root, { recursive: true, force: true });
  else console.error(`Cleanup did not finish; retained scratch: ${root}`);
}
