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

/** prepare uses only an exact-input artifact, never a stale restored WASM binary. */
export async function buildNetwork(root: string): Promise<void> {
  const hash = await networkInputHash(root);
  const directory = join(root, "browser/net");
  const asset = join(directory, "network.wasm");
  const stamp = join(directory, "network.input-hash");
  if (existsSync(asset) && existsSync(stamp) && (await readFile(stamp, "utf8")) === hash) return;
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
  await mkdir(directory, { recursive: true });
  await copyFile(join(target, "wasm32-unknown-unknown/release/waffle_tcp.wasm"), asset);
  await writeFile(stamp, hash);
}
if (import.meta.main) await buildNetwork(join(import.meta.dir, ".."));
