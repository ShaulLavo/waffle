import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { rustDependencyNotices } from "../../../tools/program-notices.ts";
import { packageRoot, source, workspaceRoot } from "./build-config.ts";

const pinnedLicenses = new Map([
  ["defmt-parser@1.0.0", "4a8cdb44891ed57b8ff5a023b6bec7137c48708f"],
  ["hifijson@0.5.0", "fcd2b9ae489d962fb245063649e497bebb571cc2"],
]);

function usePinnedLicenses(metadata: unknown) {
  const packages = (metadata as { packages: Array<Record<string, unknown>> }).packages;
  for (const [identity, revision] of pinnedLicenses) {
    const [name, version] = identity.split("@");
    const pkg = packages.find((entry) => entry.name === name && entry.version === version);
    assert.ok(pkg && typeof pkg.manifest_path === "string", identity);
    const vcs = JSON.parse(
      readFileSync(resolve(dirname(pkg.manifest_path), ".cargo_vcs_info.json"), "utf8"),
    );
    assert.equal(vcs.git.sha1, revision, identity);
    pkg.manifest_path = resolve(packageRoot, "licenses", identity.replace("@", "-"), "Cargo.toml");
  }
}

export function generateJqNotices() {
  const metadata: unknown = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        "wasm32-wasip1",
        "--manifest-path",
        resolve(source, "Cargo.toml"),
        "--no-default-features",
      ],
      { cwd: workspaceRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  usePinnedLicenses(metadata);
  const notices = rustDependencyNotices(metadata, ["jaq"]);
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    resolve(packageRoot, "dist/THIRD_PARTY_NOTICES.txt"),
    `# jaq third-party notices\n\n${notices}`,
  );
  assert.ok(notices.includes("## jaq 3.1.2"));
}
