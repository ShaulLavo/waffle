import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function networkInputHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "network/Cargo.toml",
    "tooling/build-network.ts",
  ];
  for (const entry of (await readdir(join(root, "network/src"))).sort())
    inputs.push(`network/src/${entry}`);
  for (const path of inputs) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  return hash.digest("hex");
}

/** Verify restored bytes without invoking Cargo, including in browser jobs. */
export async function verifyNetwork(root: string): Promise<void> {
  const directory = join(root, "browser/net");
  const hash = await networkInputHash(root);
  if ((await readFile(join(directory, "network.input-hash"), "utf8")) !== hash)
    throw new Error("Network artifact input hash does not match this source");
  const bytes = await readFile(join(directory, "network.wasm"));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if ((await readFile(join(directory, "network.sha256"), "utf8")) !== checksum)
    throw new Error("Network artifact checksum does not match its bytes");
}

async function compileNetwork(root: string): Promise<string> {
  if (process.env.WAFFLE_NETWORK_PREBUILT === "1")
    throw new Error("Network artifact missing, stale or corrupt; Cargo is forbidden in this job");
  const target = process.env.CARGO_TARGET_DIR ?? join(root, "target");
  const child = Bun.spawn(
    [
      "cargo",
      "build",
      "-p",
      "waffle-tcp",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--locked",
    ],
    {
      cwd: root,
      env: { ...process.env, CARGO_TARGET_DIR: target },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0)
    throw new Error(
      "Network WASM build failed. Install the pinned Rust toolchain and wasm32-unknown-unknown target.",
    );
  return join(target, "wasm32-unknown-unknown/release/waffle_tcp.wasm");
}

/** prepare reuses only an intact exact-input artifact, never stale restored bytes. */
export async function buildNetwork(root: string, compile = compileNetwork): Promise<void> {
  try {
    await verifyNetwork(root);
    return;
  } catch {
    // Local source installs rebuild; CI consumers reject here through compileNetwork.
  }
  const hash = await networkInputHash(root);
  const output = await compile(root);
  if (!existsSync(output)) throw new Error(`Network compiler did not produce ${output}`);
  const bytes = await readFile(output);
  const directory = join(root, "browser/net");
  await mkdir(directory, { recursive: true });
  await copyFile(output, join(directory, "network.wasm"));
  await writeFile(
    join(directory, "network.sha256"),
    createHash("sha256").update(bytes).digest("hex"),
  );
  await writeFile(join(directory, "network.input-hash"), hash);
}
if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  if (process.argv.includes("--verify")) await verifyNetwork(root);
  else await buildNetwork(root);
}
