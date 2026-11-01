import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, access, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { deadline } from "../src/tcp-async.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const runtime = process.env.WAFFLE_PACKAGE_ARCHIVE;
if (!runtime) throw new Error("Set WAFFLE_PACKAGE_ARCHIVE to a prepared Waffle tarball");
const scratch = await mkdtemp(
  join(process.env.WAFFLE_RELAY_TMPDIR ?? "/work/tmp", "waffle-native-install-"),
);
const children = new Set<ChildProcess>();
const asset = "webtransport-transport-http3-quiche-v1.6.11-napi-v6-linux-x64.tar.gz";
const archiveSha256 = "6340d0f657e37daaf168fe4bd77ad227653df3e3da52c96d1448a98dbfaf4c12";
const peers = {
  "@fails-components/webtransport": "1.6.11",
  "@fails-components/webtransport-transport-http3-quiche": "1.6.11",
};
const nativePeer = "@fails-components/webtransport-transport-http3-quiche";
const results: unknown[] = [];
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function startup(directory: string, native: boolean): Promise<void> {
  const port = await availablePort();
  const secret = join(directory, "secret");
  await writeFile(secret, randomBytes(32).toString("hex"), { mode: 0o600 });
  const config = join(directory, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      listen: { host: "127.0.0.1", port },
      allowedOrigins: ["http://localhost:3000"],
      tcp: {
        tokenSecretFile: secret,
        destinations: [],
        ...(native
          ? { webtransport: { bind: { host: "127.0.0.1", port: await availablePort() } } }
          : {}),
      },
    }),
  );
  const child = spawn(
    join(directory, "node_modules/.bin/waffle-relay"),
    ["serve", "--config", config],
    { cwd: directory, stdio: "ignore" },
  );
  children.add(child);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await deadline(
      (async () => {
        for (;;) {
          const response = await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => undefined);
          if (response?.ok) return;
          if (child.exitCode !== null)
            throw new Error("Package executable exited before readiness");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
      10000,
    );
  } finally {
    child.kill("SIGTERM");
    await deadline(exited, 15000).catch(async () => {
      child.kill("SIGKILL");
      await exited;
    });
    children.delete(child);
  }
}
async function install(manager: "npm" | "bun", nativeArchive: Uint8Array): Promise<void> {
  const directory = join(scratch, manager);
  await mkdir(directory);
  const manifest = {
    name: `waffle-${manager}-install-check`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { waffle: `file:${runtime}`, "waffle-relay": `file:${scratch}/relay.tgz` },
  };
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  const env = {
    ...process.env,
    npm_config_cache: join(scratch, "npm-cache"),
    BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache"),
  };
  const args =
    manager === "npm"
      ? ["install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["install", "--ignore-scripts"];
  await execute(manager, args, { cwd: directory, env, timeout: 90000 });
  await assert.rejects(
    access(join(directory, `node_modules/${nativePeer}`)),
    "WebSocket-only install pulled native peer",
  );
  await execute(
    manager === "npm" ? "node" : "bun",
    [
      "--input-type=module",
      "--eval",
      'await import("waffle-relay"); await import("waffle-relay/node")',
    ],
    { cwd: directory, env, timeout: 10000 },
  );
  await startup(directory, false);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      ...manifest,
      dependencies: { ...manifest.dependencies, ...peers },
      trustedDependencies: manager === "bun" ? [nativePeer] : [],
    }),
  );
  await execute(manager, ["install"], { cwd: directory, env, timeout: 90000, maxBuffer: 1048576 });
  const installed = await readFile(
    join(directory, `node_modules/${nativePeer}/build/Release/webtransport.node`),
  );
  assert.equal(
    digest(installed),
    digest(nativeArchive),
    "Installed native addon differs from the checksum-verified public release asset",
  );
  await execute(
    manager === "npm" ? "node" : "bun",
    ["--input-type=module", "--eval", 'await import("waffle-relay/node-webtransport")'],
    { cwd: directory, env, timeout: 10000 },
  );
  await startup(directory, true);
  const addon = await open(
    join(directory, `node_modules/${nativePeer}/build/Release/webtransport.node`),
    "r+",
  );
  const byte = Buffer.alloc(1);
  await addon.read(byte, 0, 1, 0);
  const original = byte[0]!;
  try {
    byte[0] = original ^ 255;
    await addon.write(byte, 0, 1, 0);
    await assert.rejects(
      execute(
        manager === "npm" ? "node" : "bun",
        ["--input-type=module", "--eval", 'await import("waffle-relay/node-webtransport")'],
        { cwd: directory, env, timeout: 10000 },
      ),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("native checksum mismatch"),
    );
  } finally {
    byte[0] = original;
    await addon.write(byte, 0, 1, 0);
    await addon.close();
  }

  results.push({
    manager,
    webSocketOnlyNativeAbsent: true,
    nativeInstalled: "1.6.11",
    installedAddonSha256: digest(installed),
    executableStarted: true,
    tamperedNativeRejectedBeforeLoad: true,
  });
}
try {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64", "This fixture makes only a linux-x64 runtime claim");
  await execute(
    "bun",
    ["pm", "pack", "--ignore-scripts", "--filename", join(scratch, "relay.tgz")],
    { cwd: root },
  );
  const response = await fetch(
    `https://github.com/fails-components/webtransport/releases/download/v1.6.11/${asset}`,
  );
  assert.equal(response.status, 200);
  const archive = new Uint8Array(await response.arrayBuffer());
  assert.equal(digest(archive), archiveSha256);
  await writeFile(join(scratch, asset), archive);
  const extracted = await execute(
    "tar",
    ["-xOf", join(scratch, asset), "build/Release/webtransport.node"],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  for (const manager of ["npm", "bun"] as const) await install(manager, extracted.stdout);
  console.log(JSON.stringify({ asset, archiveSha256, results }, null, 2));
} finally {
  for (const child of children) child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}
