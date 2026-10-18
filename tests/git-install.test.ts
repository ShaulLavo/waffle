import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function command(
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2] = {},
): string {
  return execFileSync(command, args, { ...options, encoding: "utf8", stdio: "pipe" }).trim();
}

test("a clean app can install Waffle from a local Git commit and import every Node export", () => {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "waffle-git-install-"));
  try {
    const bare = join(scratch, "waffle.git");
    command("git", ["clone", "--bare", root, bare]);
    const commit = command("git", ["-C", root, "rev-parse", "HEAD"]);
    const app = join(scratch, "app");
    const cache = join(scratch, "empty-cache");
    const global = join(scratch, "global");
    const config = join(scratch, "config");
    mkdirSync(app, { recursive: true });
    mkdirSync(cache, { recursive: true });
    mkdirSync(global, { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify(
        {
          name: "waffle-clean-consumer",
          private: true,
          type: "module",
          dependencies: { waffle: `git+file://${bare}#${commit}` },
          trustedDependencies: ["waffle"],
        },
        null,
        2,
      ) + "\n",
    );
    const env = {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: cache,
      BUN_INSTALL_GLOBAL_DIR: global,
      BUN_CONFIG_DIR: config,
    };
    execFileSync("bun", ["install", "--no-progress"], { cwd: app, env, stdio: "pipe" });
    const metadata = JSON.parse(
      readFileSync(join(app, "node_modules/waffle/package.json"), "utf8"),
    ) as {
      name: string;
      exports: Record<string, { node?: string }>;
    };
    const specifiers = Object.entries(metadata.exports)
      .filter(([, target]) => target.node !== undefined)
      .map(([key]) => (key === "." ? metadata.name : `${metadata.name}${key.slice(1)}`));
    const script = `for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier);`;
    expect(() =>
      execFileSync("node", ["--input-type=module", "--eval", script], {
        cwd: app,
        env,
        stdio: "pipe",
      }),
    ).not.toThrow();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
