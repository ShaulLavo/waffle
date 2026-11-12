// Producer-only raw installation proof. Consumer jobs must only verify prepared artifacts.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import manifest from "../package.json" with { type: "json" };
import { NETWORK_ASSETS } from "./build-network.js";

async function rawNetworkInstall(root = join(import.meta.dir, "..")): Promise<void> {
  const rawScratch = await mkdtemp(
    join(process.env.WAFFLE_RAW_SOURCE_SCRATCH_ROOT ?? tmpdir(), "waffle-raw-source-"),
  );
  try {
    assertNoAncestorDependencies(rawScratch);
    const raw = join(rawScratch, "source");
    await mkdir(raw);
    for (const file of manifest.files.filter((file) => file !== "dist")) {
      await cp(join(root, file), join(raw, file), {
        recursive: true,
        filter: (path) =>
          !NETWORK_ASSETS.some((asset) => path === join(root, "browser/net", asset)),
      });
    }
    for (const asset of NETWORK_ASSETS)
      if (existsSync(join(raw, "browser/net", asset)))
        throw Error("raw source retained generated network assets");
    const env = {
      ...process.env,
      WAFFLE_NETWORK_PREBUILT: "0",
      NODE_PATH: "",
      CARGO_TARGET_DIR: join(rawScratch, "target"),
    };
    execFileSync(
      process.execPath,
      ["install", "--production", "--ignore-scripts", "--backend=copyfile", "--no-progress"],
      { cwd: raw, env, stdio: "pipe" },
    );
    execFileSync(process.execPath, ["prepare.ts"], { cwd: raw, env, stdio: "pipe" });
    for (const asset of NETWORK_ASSETS) {
      if (
        !existsSync(join(raw, "browser/net", asset)) ||
        !existsSync(join(raw, "dist/browser/net", asset))
      )
        throw Error(`raw source failed to prepare ${asset}`);
    }
    execFileSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        'const {loadBufferNetworkModule}=await import("./dist/browser/net/buffer-module.js"); const owner=(await loadBufferNetworkModule()).create(); try { if(owner.call("net_pair")<1)throw Error("raw Node network failed"); }finally{owner.dispose();}',
      ],
      { cwd: raw, stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [
        "--eval",
        'const result=await Bun.build({entrypoints:["./browser/net/buffer-module.ts"],target:"browser",splitting:true,outdir:"./consumer-build"}); if(!result.success)throw new AggregateError(result.logs);',
      ],
      { cwd: raw, stdio: "pipe" },
    );
    console.log(
      "network raw install: private source rebuilt both forms and Node/browser closure without ancestor dependencies",
    );
  } finally {
    await rm(rawScratch, { recursive: true, force: true });
  }
}
function assertNoAncestorDependencies(directory: string): void {
  for (let parent = dirname(directory); ; parent = dirname(parent)) {
    if (existsSync(join(parent, "node_modules")))
      throw Error(
        `Raw source fixture has ancestor dependencies at ${parent}; set WAFFLE_RAW_SOURCE_SCRATCH_ROOT to an isolated data-drive directory`,
      );
    if (parent === dirname(parent)) return;
  }
}

if (import.meta.main) await rawNetworkInstall();
