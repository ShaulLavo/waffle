import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const NETWORK_TRANSLATOR = {
  version: "132.0.0",
  integrity:
    "sha512-4Usg7yEvwO3FMso3Oov6qkOOHSod1IEv+boKkh77kTljM+eNBouqCTbqWswGzbG+vDNO/b/v2C4gfEh1WgB9Lg==",
  executableSha256: "9961490d6c2835c70417dcb74c4578fe3760a00529b3ec6c862a086979304e69",
  reports: "wasm2js version 132 (version_132)",
  flags: [
    "--emscripten",
    "-O2",
    "--enable-bulk-memory",
    "--enable-sign-ext",
    "--enable-nontrapping-float-to-int",
    "--enable-mutable-globals",
    "--enable-multivalue",
    "--enable-reference-types",
  ],
} as const;
const pinDirectory = join(import.meta.dir, "network-translator");

export function networkToolCache(): string {
  if (process.env.WAFFLE_TOOL_CACHE) return process.env.WAFFLE_TOOL_CACHE;
  const home = homedir();
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? join(home, "AppData/Local"), "waffle/tools");
  if (process.platform === "darwin") return join(home, "Library/Caches/waffle/tools");
  return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "waffle/tools");
}
export async function networkTranslatorPin(): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(NETWORK_TRANSLATOR));
  for (const file of ["package.json", "bun.lock"])
    hash.update(await readFile(join(pinDirectory, file)));
  return hash.digest("hex");
}
async function verify(directory: string, signal?: AbortSignal): Promise<string> {
  const executable = join(directory, "node_modules/binaryen/bin/wasm2js");
  const bytes = await readFile(executable);
  for (const file of ["package.json", "bun.lock"]) {
    if (!(await readFile(join(directory, file))).equals(await readFile(join(pinDirectory, file))))
      throw new Error(`Network translator pin mismatch: ${directory}`);
  }
  const packageRoot = join(directory, "node_modules/binaryen");
  const names = await readdir(packageRoot);
  if (names.some((name) => /^NOTICE(?:\.|$)/i.test(name)))
    throw new Error("Binaryen NOTICE changed; audit generated attribution");
  if (!(await readFile(join(packageRoot, "LICENSE"), "utf8")).includes("Apache License"))
    throw new Error("Binaryen license changed; audit generated attribution");
  if (createHash("sha256").update(bytes).digest("hex") !== NETWORK_TRANSLATOR.executableSha256)
    throw new Error(
      `Published network translator is corrupt: ${directory}; remove it manually when unused`,
    );
  const manifest: unknown = JSON.parse(
    await readFile(join(directory, "node_modules/binaryen/package.json"), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    manifest.version !== NETWORK_TRANSLATOR.version
  )
    throw new Error(`Network translator version mismatch: ${directory}`);
  const child = Bun.spawn([process.execPath, executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 || output.trim() !== NETWORK_TRANSLATOR.reports)
    throw new Error(`Network translator version check failed: ${output.trim()} ${errors.trim()}`);
  return executable;
}
/** Published pins are immutable. Never delete or repair another producer's directory. */
export async function provisionNetworkTranslator(
  cache = networkToolCache(),
  signal?: AbortSignal,
): Promise<string> {
  const interruption = new AbortController();
  const stop = () => interruption.abort(Error("Network translator provisioning interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await provision(
      cache,
      signal ? AbortSignal.any([signal, interruption.signal]) : interruption.signal,
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
async function provision(cache: string, signal: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const pin = await networkTranslatorPin();
  const published = join(cache, `network-translator-${pin.slice(0, 16)}`);
  if (existsSync(published)) return verify(published, signal);
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, ".network-translator-"));
  try {
    await install(temporary, signal);
    signal?.throwIfAborted();
    await verify(temporary, signal);
    await publishNetworkTranslator(temporary, published);
    return await verify(published, signal);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function install(directory: string, signal?: AbortSignal): Promise<void> {
  for (const file of ["package.json", "bun.lock"])
    await copyFile(join(pinDirectory, file), join(directory, file));
  const lock = await readFile(join(directory, "bun.lock"), "utf8");
  if (!lock.includes(NETWORK_TRANSLATOR.integrity))
    throw new Error("Network translator integrity pin mismatch");
  const child = Bun.spawn(
    [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"],
    {
      cwd: directory,
      signal,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0) throw new Error("Pinned network translator installation failed");
}
export async function publishNetworkTranslator(
  temporary: string,
  published: string,
  move = rename,
): Promise<void> {
  // POSIX reports EEXIST/ENOTEMPTY; Windows may report EPERM/EACCES. In every case a
  // publication winner must exist and pass verification; otherwise preserve the real error.
  try {
    await move(temporary, published);
  } catch (error) {
    if (!existsSync(published)) throw error;
    await verify(published);
  }
}
