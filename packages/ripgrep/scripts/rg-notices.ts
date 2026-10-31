import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function ripgrepNotices(source: string, env: NodeJS.ProcessEnv): Promise<string> {
  const metadata: unknown = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1", "--filter-platform", "wasm32-wasip1"],
      {
        cwd: source,
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  );
  assert.ok(metadata && typeof metadata === "object" && "packages" in metadata);
  assert.ok(Array.isArray(metadata.packages));
  const packages: unknown[] = metadata.packages;
  let text = "# Ripgrep third-party notices\n\n";
  for (const pkg of packages) text += await packageNotices(pkg);
  return text;
}

async function packageNotices(pkg: unknown): Promise<string> {
  assert.ok(pkg && typeof pkg === "object");
  assert.ok("name" in pkg && typeof pkg.name === "string");
  assert.ok("version" in pkg && typeof pkg.version === "string");
  assert.ok("manifest_path" in pkg && typeof pkg.manifest_path === "string");
  const directory = dirname(pkg.manifest_path);
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && /^(license|copying|notice|unlicense)(\.|-|$)/i.test(entry.name),
    )
    .map((entry) => entry.name);
  names.sort();
  assert.ok(names.length, `Missing license text for ${pkg.name} ${pkg.version}`);
  let text = "";
  for (const name of names)
    text += `## ${pkg.name} ${pkg.version} / ${name}\n\n${await readFile(resolve(directory, name), "utf8")}\n\n`;
  return text;
}
