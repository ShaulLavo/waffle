import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const source = {
  version: "8.23.0",
  url: "https://curl.se/download/curl-8.23.0.tar.xz",
  sha256: "8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5",
};
export const configureFlags = [
  "--prefix=/unused-native-curl",
  "--disable-shared",
  "--enable-static",
  "--without-ssl",
  "--without-zlib",
  "--without-brotli",
  "--without-zstd",
  "--without-libpsl",
  "--without-libidn2",
  "--without-libssh2",
  "--without-libssh",
  "--without-nghttp2",
  "--without-nghttp3",
  "--without-ngtcp2",
  "--without-quiche",
  "--without-libgsasl",
  "--without-gssapi",
  "--without-libuv",
  "--disable-ares",
  "--disable-ldap",
  "--disable-ldaps",
  "--disable-ftp",
  "--disable-file",
  "--disable-ipfs",
  "--disable-rtsp",
  "--disable-proxy",
  "--disable-dict",
  "--disable-telnet",
  "--disable-tftp",
  "--disable-pop3",
  "--disable-imap",
  "--disable-smtp",
  "--disable-gopher",
  "--disable-mqtt",
  "--disable-websockets",
  "--disable-docs",
  "--disable-manual",
  "--disable-dependency-tracking",
  "--disable-alt-svc",
  "--disable-hsts",
  "--disable-unix-sockets",
  "--disable-netrc",
  "--disable-doh",
];
const cflags = "-O2 -g0";
const ldflags = "-Wl,-s";
const baseEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent-waffle-curl-oracle",
  CURL_HOME: "/nonexistent-waffle-curl-oracle",
  LC_ALL: "C",
  TZ: "UTC",
  CONFIG_SITE: "/dev/null",
  SOURCE_DATE_EPOCH: "1791936000",
};
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

// Each child owns a process group, including make's compiler children.
export function command(
  file: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 5000,
  env: NodeJS.ProcessEnv = baseEnv,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (reason: Error) => {
      failure ??= reason;
      killGroup(child.pid);
    };
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) return stop(new Error("Oracle command output limit exceeded"));
      chunks.push(chunk);
    };
    const abort = () => stop(new Error("Oracle command aborted"));
    const timer = setTimeout(() => stop(new Error(`Oracle command deadline: ${file}`)), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${file} exited ${code}: ${output.slice(-6000)}`));
      resolveResult(output);
    });
  });
}

function fileHash(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
    throw new Error(`Not a bounded regular file: ${path}`);
  return sha256(readFileSync(path));
}

export async function identity(signal: AbortSignal) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Oracle requires Linux x86_64");
  const compiler = realpathSync("/usr/bin/gcc");
  const cwd = process.cwd();
  const inputs = {
    schema: 1,
    source,
    configureFlags,
    cflags,
    ldflags,
    platform: process.platform,
    arch: process.arch,
    recipeSha256: fileHash(fileURLToPath(import.meta.url)),
    compiler: {
      path: compiler,
      sha256: fileHash(compiler),
      version: await command(compiler, ["--version"], cwd, signal),
      target: (await command(compiler, ["-dumpmachine"], cwd, signal)).trim(),
    },
    libc: (await command("/usr/bin/getconf", ["GNU_LIBC_VERSION"], cwd, signal)).trim(),
    os: readFileSync("/etc/os-release", "utf8"),
    make: {
      sha256: fileHash(realpathSync("/usr/bin/make")),
      version: await command("/usr/bin/make", ["--version"], cwd, signal),
    },
  };
  return { key: `curl-http-${source.version}-${sha256(JSON.stringify(inputs))}`, inputs };
}
export type Identity = Awaited<ReturnType<typeof identity>>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid oracle receipt");
  return Object.fromEntries(Object.entries(value));
}
function validateVersion(text: string): void {
  const first = text.split("\n")[0] ?? "";
  if (!/^curl 8\.23\.0 \([^\s()]+\) libcurl\/8\.23\.0$/.test(first))
    throw new Error(`Unexpected oracle version/dependencies: ${first}`);
  if (!/^Protocols: http$/m.test(text)) throw new Error("Oracle must support HTTP only");
  if (/^Features:.*\b(SSL|HTTP2|HTTP3|libz|brotli|zstd|IDN|PSL|GSS-API|SPNEGO)\b/m.test(text))
    throw new Error("Unexpected optional oracle feature");
}

export async function verify(directory: string, expected: Identity, signal: AbortSignal) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("Oracle directory is not regular");
  const path = join(directory, "curl");
  const receiptPath = join(directory, "receipt.json");
  fileHash(receiptPath);
  const receipt = record(JSON.parse(readFileSync(receiptPath, "utf8")));
  if (
    receipt.key !== expected.key ||
    JSON.stringify(receipt.inputs) !== JSON.stringify(expected.inputs)
  )
    throw new Error("Oracle cache identity mismatch");
  const binaryHash = fileHash(path);
  if (receipt.binarySha256 !== binaryHash)
    throw new Error("Oracle cache binary digest mismatch before execution");
  const bytes = readFileSync(path);
  if (
    bytes[0] !== 127 ||
    bytes.subarray(1, 4).toString() !== "ELF" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  )
    throw new Error("Oracle is not Linux x86_64 ELF");
  if (typeof receipt.version !== "string" || receipt.binaryBytes !== bytes.length)
    throw new Error("Oracle receipt is incomplete");
  validateVersion(receipt.version);
  // Hash, identity, format and recorded version are checked before this first execution.
  chmodSync(path, 0o700);
  const version = await command(path, ["-q", "--version"], directory, signal);
  validateVersion(version);
  if (version !== receipt.version) throw new Error("Oracle runtime version differs from receipt");
  return { path, binarySha256: binaryHash, binaryBytes: bytes.length, version };
}

async function build(scratch: string, expected: Identity, signal: AbortSignal) {
  const archive = join(scratch, "curl.tar.xz");
  const supplied = process.env.CURL_NATIVE_SOURCE_ARCHIVE;
  if (supplied) copyFileSync(supplied, archive);
  if (!supplied)
    await command(
      "/usr/bin/curl",
      [
        "-q",
        "--fail",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--connect-timeout",
        "10",
        "--max-time",
        "60",
        "--max-filesize",
        "8388608",
        source.url,
        "-o",
        archive,
      ],
      scratch,
      signal,
      65000,
    );
  if (fileHash(archive) !== source.sha256)
    throw new Error("Oracle source checksum mismatch before extraction");
  await command("/usr/bin/tar", ["-xJf", archive, "-C", scratch], scratch, signal, 30000);
  const tree = join(scratch, `curl-${source.version}`);
  const env = {
    ...baseEnv,
    TMPDIR: scratch,
    CC: expected.inputs.compiler.path,
    CFLAGS: cflags,
    LDFLAGS: ldflags,
  };
  const configure = await command(
    join(tree, "configure"),
    configureFlags,
    tree,
    signal,
    120000,
    env,
  );
  writeFileSync(join(scratch, "configure.log"), configure);
  if (/unrecognized options:/i.test(configure))
    throw new Error("Unrecognized curl configure option");
  const library = await command("/usr/bin/make", ["-j2", "-C", "lib"], tree, signal, 180000, env);
  const tool = await command("/usr/bin/make", ["-j2", "-C", "src"], tree, signal, 90000, env);
  const binary = join(tree, "src", "curl");
  const version = await command(binary, ["-q", "--version"], tree, signal);
  validateVersion(version);
  const staged = join(scratch, "validated");
  mkdirSync(staged);
  copyFileSync(binary, join(staged, "curl"));
  const receipt = {
    ...expected,
    binarySha256: fileHash(binary),
    binaryBytes: lstatSync(binary).size,
    version,
  };
  writeFileSync(join(staged, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  if (process.env.CURL_NATIVE_BUILD_LOG)
    writeFileSync(process.env.CURL_NATIVE_BUILD_LOG, configure.concat(library, tool));
  return staged;
}

function requiredDirectory(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || /[\r\n]/.test(value))
    throw new Error(`${name} must be an absolute single-line path`);
  return resolve(value);
}

export async function provision(
  cache: string,
  scratchRoot: string,
  expected: Identity,
  signal: AbortSignal,
) {
  mkdirSync(cache, { recursive: true });
  const directory = join(cache, expected.key);
  if (existsSync(directory)) return { hit: true, ...(await verify(directory, expected, signal)) };
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "curl-native-"));
  try {
    const staged = await build(scratch, expected, signal);
    await verify(staged, expected, signal);
    renameSync(staged, directory);
    return { hit: false, ...(await verify(directory, expected, signal)) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(480000)]);
  try {
    const expected = await identity(signal);
    const cache = requiredDirectory("NATIVE_CURL_CACHE");
    const directory = join(cache, expected.key);
    const action = process.argv[2];
    if (action === "key") {
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `key=${expected.key}\ndirectory=${directory}\n`);
      console.log(JSON.stringify({ key: expected.key, directory }));
      return;
    }
    if (action !== "provision" && action !== "verify")
      throw new Error("Usage: curl-native-oracle.ts key|provision|verify");
    const result =
      action === "verify"
        ? await verify(directory, expected, signal)
        : await provision(cache, requiredDirectory("CURL_NATIVE_SCRATCH_ROOT"), expected, signal);
    if (process.env.GITHUB_ENV)
      appendFileSync(process.env.GITHUB_ENV, `NATIVE_CURL=${result.path}\n`);
    console.log(JSON.stringify({ key: expected.key, ...result }, null, 2));
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}
if (import.meta.main) await main();
